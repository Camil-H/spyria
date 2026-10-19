import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatId, chatId } from '@spyria/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { createGitHubApi } from './github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './testing/fake-github.ts'
import { acme, alice, bob, lee, sessionTokenOf, startAgentStack, testSecretsKey, waitFor } from './testing/testing.ts'

setDefaultTimeout(60_000)
const fakeGitHub = startFakeGitHub()
const secretBox = createSecretBox(testSecretsKey)
const stack = await startAgentStack({ routing: true, github: { api: createGitHubApi(fakeGitHub.urls), secretBox } })
afterAll(() => fakeGitHub.stop())
const { app, database } = stack
const ownerOnly = 'Only Alice can commit or update the branch in this chat'

const request = async (userId: string, method: string, path: string, body?: object) => {
  const response = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}`,
      'content-type': 'application/json',
    },
    body: body && JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
const gitAction = (userId: string, chat: ChatId, action: string, message = '') =>
  request(userId, 'POST', `/api/chats/${chat}/git/${action}`, { message })
const statusOf = async (userId: string, chat: ChatId) =>
  (await request(userId, 'GET', `/api/chats/${chat}/workspace/status?path=`)).body
const gitIn = (cwd: string, ...command: string[]) =>
  Bun.spawnSync(['git', '-c', 'user.name=Pi Agent', '-c', 'user.email=agent@example.com', ...command], {
    cwd,
  }).stdout.toString()

expect(
  await request(alice, 'POST', '/api/github-settings', {
    appId: fakeGitHubAppId,
    clientId: fakeGitHubClientId,
    clientSecret: fakeGitHubClientSecret,
    privateKey: fakeGitHub.appPrivateKey,
    webhookSecret: 'whsec-git-actions-0123',
  }),
).toMatchObject({ status: 200 })

const connectGitHub = async (userId: string) => {
  const started = await request(userId, 'POST', '/api/github/connection/connect')
  const authorized = await fetch(started.body.authorizeUrl, { redirect: 'manual' })
  const callback = new URL(authorized.headers.get('location') ?? '')
  expect((await app.request(`${callback.pathname}${callback.search}`)).status).toBe(200)
}
const baseBranchOf = (name: string) => {
  const branch = `e2e-base-${name}`
  fakeGitHub.commitToBranch('acme/app', {
    branch,
    files: { [`docs/${name}.md`]: `${name}\n` },
    message: `Start ${name}`,
  })
  return branch
}
const newDevChat = async (baseBranch: string, participants: { memberId: string; roleId: string }[] = []) => {
  const created = await request(alice, 'POST', '/api/dev-chats', {
    name: 'Git actions',
    projectId: null,
    repository: 'acme/app',
    baseBranch,
  })
  const id = chatId(String(created.body.chatId))
  await stack.mutate({ workspaceId: acme, userId: alice }, 'conversation.updateChatRouting', {
    workspaceId: acme,
    chatId: id,
    runsOn: 'runtime',
  })
  for (const { memberId, roleId } of participants)
    await database.$client`
      insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${memberId}, ${roleId})`
  const [{ git_branch: branch } = {}] = await database.$client`select git_branch from chats where id = ${id}`
  return { id, branch: String(branch) }
}
const runtimeWorkspaceOf = async (id: ChatId) => {
  const promptId = await stack.prompt(id, 'stub:ls')
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  const frames = (await stack.subscribedFrames(id)).map((frame) => JSON.parse(frame))
  return { promptId, workspace: String(frames.find((frame) => frame.workspace)?.workspace.cwd) }
}
const agentCommit = (workspace: string, total: number) => {
  writeFileSync(join(workspace, 'src/app.ts'), `export const total = ${total}\n`)
  gitIn(workspace, 'commit', '-qam', `Set the total to ${total}`)
}

test('only the owner commits and updates from base; prompters and editors are refused, as are an empty message and nothing to commit; the author comes from GitHub, else Spyria', async () => {
  await stack.agentHost('Git roles host')
  const { id, branch } = await newDevChat(baseBranchOf('roles'), [
    { memberId: bob, roleId: 'prompter' },
    { memberId: lee, roleId: 'editor' },
  ])
  const { workspace } = await runtimeWorkspaceOf(id)
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 2\n')
  for (const guest of [bob, lee])
    for (const action of ['commit', 'update'])
      expect(await gitAction(guest, id, action, 'Guest commit')).toEqual({
        status: 403,
        body: { isRefused: true, text: ownerOnly },
      })
  expect(gitIn(workspace, 'log', '-1', '--format=%s')).toBe('Start roles\n')
  expect(await gitAction(alice, id, 'commit', '  ')).toEqual({
    status: 403,
    body: { isRefused: true, text: 'Write a commit message' },
  })
  expect((await gitAction(alice, id, 'push')).status).toBe(400)

  const committed = await gitAction(alice, id, 'commit', 'Raise the total')
  expect(committed.status).toBe(200)
  expect(committed.body.text).toMatch(/^Committed [0-9a-f]{7}$/)
  expect(gitIn(workspace, 'log', '-1', '--format=%s|%an|%ae')).toBe(
    `Raise the total|Alice|${alice}@users.noreply.spyria\n`,
  )
  expect(await gitAction(alice, id, 'commit', 'Again')).toEqual({
    status: 403,
    body: { isRefused: true, text: 'There is nothing to commit' },
  })

  await connectGitHub(alice)
  expect((await request(alice, 'POST', `/api/chats/${id}/publish/push`, {})).body.text).toBe(`Pushed ${branch}`)
  expect(await statusOf(bob, id)).toMatchObject({ isLive: true, aheadOfBase: 1, aheadOfPushed: 0, uncommitted: 0 })
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 3\n')
  writeFileSync(join(workspace, 'notes.md'), 'notes\n')
  expect(await statusOf(lee, id)).toMatchObject({ uncommitted: 2 })
  expect((await gitAction(alice, id, 'commit', 'Name the total')).status).toBe(200)
  expect(gitIn(workspace, 'log', '-1', '--format=%s|%an|%ae')).toBe(
    'Name the total|Alice Martin|1001+alice-martin@users.noreply.github.com\n',
  )
  const status = await statusOf(bob, id)
  expect(status).toMatchObject({
    isLive: true,
    aheadOfBase: 2,
    behindBase: 0,
    aheadOfPushed: 1,
    behindPushed: 0,
    uncommitted: 0,
  })
  expect(Date.now() - Date.parse(status.pushedAt)).toBeLessThan(60_000)
})

test('commit and update are refused while an agent turn runs and while the runtime sleeps', async () => {
  const { host, relay } = await stack.agentHost('Git busy host')
  const { id } = await newDevChat(baseBranchOf('busy'))
  const { promptId, workspace } = await runtimeWorkspaceOf(id)
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 2\n')
  await database.$client`update chats set agent_turn_message_id = ${promptId} where id = ${id}`
  for (const action of ['commit', 'update'])
    expect(await gitAction(alice, id, action, 'Busy')).toEqual({
      status: 403,
      body: { isRefused: true, text: 'The agent is working: wait for its turn to end' },
    })
  await database.$client`update chats set agent_turn_message_id = null where id = ${id}`

  const runtime = await stack.runtimeOf(id)
  const container = host.containers.get(String(runtime.id))
  if (container) {
    container.running = false
    relay.containerAgent.stopped(container)
  }
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${id}`
  for (const action of ['commit', 'update'])
    expect(await gitAction(alice, id, action, 'Asleep')).toEqual({
      status: 403,
      body: { isRefused: true, text: 'The runtime is asleep: wake it first' },
    })
  expect(gitIn(workspace, 'status', '--porcelain')).toBe(' M src/app.ts\n')
  expect((await stack.runtimeOf(id)).state).toBe('stopped')
})

test('update from base merges the base’s new commit from a thin bundle of the base only; no token reaches spyria-agent or the runtime', async () => {
  const { relay } = await stack.agentHost('Git update host')
  const baseBranch = baseBranchOf('merge')
  const { id, branch } = await newDevChat(baseBranch)
  const { workspace } = await runtimeWorkspaceOf(id)
  agentCommit(workspace, 2)
  const previousBase = fakeGitHub.branchHeadOf('acme/app', baseBranch)
  expect(await statusOf(alice, id)).toMatchObject({ baseHead: previousBase, aheadOfBase: 1, behindBase: 0 })
  const newBase = fakeGitHub.commitToBranch('acme/app', {
    branch: baseBranch,
    files: { 'docs/from-base.md': 'from base\n' },
    message: 'Add the base docs',
  })
  const requestsBefore = relay.requests.length
  const issuedBefore = new Set(fakeGitHub.installationTokens.keys())

  expect(await gitAction(alice, id, 'update')).toEqual({
    status: 200,
    body: { isRefused: false, text: `Merged ${baseBranch}` },
  })
  const agentCommitSha = gitIn(workspace, 'rev-parse', 'HEAD~1').trim()
  expect(gitIn(workspace, 'log', '-1', '--format=%s|%an|%P')).toBe(
    `Merge branch '${baseBranch}' into ${branch}|Alice Martin|${agentCommitSha} ${newBase}\n`,
  )
  expect(readFileSync(join(workspace, 'docs/from-base.md'), 'utf8')).toBe('from base\n')
  expect(gitIn(workspace, 'rev-parse', 'refs/hq/base').trim()).toBe(newBase)
  expect(gitIn(workspace, 'rev-parse', `refs/remotes/origin/${baseBranch}`).trim()).toBe(previousBase)
  expect(await statusOf(alice, id)).toMatchObject({ baseHead: newBase, aheadOfBase: 2, behindBase: 0 })

  const updateRequests = relay.requests.slice(requestsBefore)
  const [merge] = updateRequests.filter(({ path }) => path === '/api/workspace/merge')
  const { bundle, head, base } = JSON.parse(String(merge?.body))
  expect([head, base]).toEqual([newBase, baseBranch])
  const bundleFile = join(tmpdir(), `spyria-git-actions-${crypto.randomUUID()}.bundle`)
  writeFileSync(bundleFile, Buffer.from(bundle, 'base64'))
  expect(Bun.spawnSync(['git', 'bundle', 'list-heads', bundleFile]).stdout.toString()).toBe(
    `${newBase} refs/heads/${baseBranch}\n`,
  )
  const verified = Bun.spawnSync(['git', 'bundle', 'verify', bundleFile], { cwd: workspace })
  expect(`${verified.stdout}${verified.stderr}`).toContain(previousBase)
  const updateTokens = [...fakeGitHub.installationTokens.keys()].filter((token) => !issuedBefore.has(token))
  expect(updateTokens).toHaveLength(1)
  expect(fakeGitHub.installationTokens.get(updateTokens[0] ?? '')).toMatchObject({
    repositories: ['app'],
    permissions: { contents: 'read' },
  })
  const sentToRuntime = JSON.stringify(updateRequests)
  for (const token of [...fakeGitHub.installationTokens.keys(), ...fakeGitHub.userTokens()])
    expect(sentToRuntime).not.toContain(token)
  for (const token of fakeGitHub.installationTokens.keys())
    expect(readFileSync(join(workspace, '.git/config'), 'utf8')).not.toContain(token)

  expect((await gitAction(alice, id, 'update')).body).toEqual({
    isRefused: false,
    text: `Already up to date with ${baseBranch}`,
  })
})

test('a conflicting update is aborted with the working copy clean and names the conflicting files', async () => {
  await stack.agentHost('Git conflict host')
  const baseBranch = baseBranchOf('conflict')
  const { id } = await newDevChat(baseBranch)
  const { workspace } = await runtimeWorkspaceOf(id)
  agentCommit(workspace, 2)
  const before = gitIn(workspace, 'rev-parse', 'HEAD')
  fakeGitHub.commitToBranch('acme/app', {
    branch: baseBranch,
    files: { 'src/app.ts': 'export const total = 3\n' },
    message: 'Raise the total on the base',
  })
  expect(await gitAction(alice, id, 'update')).toEqual({
    status: 403,
    body: {
      isRefused: true,
      text: `Updating from ${baseBranch} conflicts in src/app.ts; the merge was aborted`,
      conflicts: ['src/app.ts'],
    },
  })
  expect(gitIn(workspace, 'rev-parse', 'HEAD')).toBe(before)
  expect(gitIn(workspace, 'status', '--porcelain')).toBe('')
  expect(existsSync(join(workspace, '.git/MERGE_HEAD'))).toBe(false)
  expect(await statusOf(alice, id)).toMatchObject({ aheadOfBase: 1, behindBase: 1, uncommitted: 0 })
})
