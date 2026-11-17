import { expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatId } from '@spyria/kernel'
import { fakeGitHubLogin, fakeGitHubUserId } from './testing/fake-github.ts'
import { gitIn, startGitHubStack } from './testing/github-stack.ts'
import { alice, bob, lee, waitFor } from './testing/testing.ts'

setDefaultTimeout(60_000)
const {
  stack,
  fakeGitHub,
  request,
  configureGitHubApp,
  connectGitHub,
  newDevChat: newGitHubDevChat,
  runtimeWorkspaceOf,
} = await startGitHubStack({ routing: true })
const { database } = stack
const ownerOnly = 'Only Alice can commit or update the branch in this chat'

const gitAction = (userId: string, chat: ChatId, action: string, message = '') =>
  request(userId, 'POST', `/api/chats/${chat}/git/${action}`, { message })
const statusOf = async (userId: string, chat: ChatId) =>
  (await request(userId, 'GET', `/api/chats/${chat}/workspace/status?path=`)).body
await configureGitHubApp('whsec-git-actions-0123')

const baseBranchOf = (name: string) => {
  const branch = `e2e-base-${name}`
  fakeGitHub.commitToBranch('acme/app', {
    branch,
    files: { [`docs/${name}.md`]: `${name}\n` },
    message: `Start ${name}`,
  })
  return branch
}
const newDevChat = (baseBranch: string, participants: { memberId: string; roleId: string }[] = []) =>
  newGitHubDevChat({ baseBranch, participants })
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
    'Name the total|alice-martin|1001+alice-martin@users.noreply.github.com\n',
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

test('the agent commits as the owner’s GitHub account, set when the runtime starts and read once per member; no token reaches the repository config', async () => {
  await stack.agentHost('Git author host')
  await connectGitHub(alice)
  const githubAuthor = `${fakeGitHubLogin}|${fakeGitHubUserId}+${fakeGitHubLogin}@users.noreply.github.com`
  const agentCommitAuthorIn = (workspace: string) => {
    writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 5\n')
    const commit = Bun.spawnSync(['git', 'commit', '-qam', 'Set the total to 5'], { cwd: workspace })
    expect(commit.stderr.toString()).toBe('')
    expect(commit.exitCode).toBe(0)
    return Bun.spawnSync(['git', 'log', '-1', '--format=%an|%ae|%cn|%ce'], { cwd: workspace }).stdout.toString()
  }
  const first = await runtimeWorkspaceOf((await newDevChat(baseBranchOf('author-first'))).id)
  expect(agentCommitAuthorIn(first.workspace)).toBe(`${githubAuthor}|${githubAuthor}\n`)
  expect(readFileSync(join(first.workspace, '.git/config'), 'utf8')).not.toContain('extraHeader')

  const userReadsBefore = fakeGitHub.apiRequests.filter((call) => call === 'GET /user').length
  const second = await newDevChat(baseBranchOf('author-second'))
  const { workspace } = await runtimeWorkspaceOf(second.id)
  expect(agentCommitAuthorIn(workspace)).toBe(`${githubAuthor}|${githubAuthor}\n`)
  writeFileSync(join(workspace, 'notes.md'), 'notes\n')
  expect((await gitAction(alice, second.id, 'commit', 'Add notes')).status).toBe(200)
  expect(fakeGitHub.apiRequests.filter((call) => call === 'GET /user').length).toBe(userReadsBefore)
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
    `Merge branch '${baseBranch}' into ${branch}|alice-martin|${agentCommitSha} ${newBase}\n`,
  )
  expect(readFileSync(join(workspace, 'docs/from-base.md'), 'utf8')).toBe('from base\n')
  expect(gitIn(workspace, 'rev-parse', 'refs/spyria/base').trim()).toBe(newBase)
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

test('the agent fetches a branch into origin/<branch> from a thin bundle of that branch only, with no token reaching the runtime; the working branch is untouched and a missing branch is named', async () => {
  const { relay } = await stack.agentHost('Git fetch host', { routesModelCalls: true })
  const baseBranch = baseBranchOf('fetch')
  const { id, branch } = await newDevChat(baseBranch)
  const { workspace } = await runtimeWorkspaceOf(id)
  agentCommit(workspace, 2)
  const workingHead = gitIn(workspace, 'rev-parse', 'HEAD').trim()
  const baseHead = fakeGitHub.branchHeadOf('acme/app', baseBranch)
  const feature = `e2e-feature-${crypto.randomUUID().slice(0, 8)}`
  const featureHead = fakeGitHub.commitToBranch('acme/app', {
    branch: feature,
    from: baseBranch,
    files: { 'docs/feature.md': 'feature\n' },
    message: 'Add the feature docs',
  })
  const requestsBefore = relay.requests.length
  const issuedBefore = new Set(fakeGitHub.installationTokens.keys())
  stack.setFakeLlmScript({
    steps: [
      { tool: 'fetch_branch', arguments: { branch: `origin/${feature}` } },
      { tool: 'fetch_branch', arguments: { branch: 'e2e-missing' } },
    ],
    text: 'Fetched.',
  })
  const promptId = await stack.prompt(id, 'Fetch the feature branch')
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  const toolResults = (await stack.repliesTo(promptId, ['step'])).flatMap(({ step }) => {
    const toolStep = step as { type?: string; result?: string } | undefined
    return toolStep?.type === 'tool' ? [toolStep.result] : []
  })
  expect(toolResults).toEqual([
    `Fetched ${feature} at ${featureHead.slice(0, 7)} into origin/${feature}`,
    'There is no branch e2e-missing on GitHub',
  ])
  expect(gitIn(workspace, 'rev-parse', `refs/remotes/origin/${feature}`).trim()).toBe(featureHead)
  expect(gitIn(workspace, 'rev-parse', 'HEAD').trim()).toBe(workingHead)
  expect(gitIn(workspace, 'branch', '--show-current').trim()).toBe(branch)

  const fetchRequests = relay.requests.slice(requestsBefore)
  const [fetched, ...otherFetches] = fetchRequests.filter(({ path }) => path === '/api/workspace/fetch')
  expect(otherFetches).toEqual([])
  const { bundle, head } = JSON.parse(String(fetched?.body))
  expect(head).toBe(featureHead)
  const bundleFile = join(tmpdir(), `spyria-git-fetch-${crypto.randomUUID()}.bundle`)
  writeFileSync(bundleFile, Buffer.from(bundle, 'base64'))
  expect(Bun.spawnSync(['git', 'bundle', 'list-heads', bundleFile]).stdout.toString()).toBe(
    `${featureHead} refs/heads/${feature}\n`,
  )
  const verified = Bun.spawnSync(['git', 'bundle', 'verify', bundleFile], { cwd: workspace })
  expect(`${verified.stdout}${verified.stderr}`).toContain(baseHead)
  const fetchTokens = [...fakeGitHub.installationTokens.keys()].filter((token) => !issuedBefore.has(token))
  expect(fetchTokens.map((token) => fakeGitHub.installationTokens.get(token))).toEqual([
    expect.objectContaining({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } }),
    expect.objectContaining({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } }),
  ])
  const sentToRuntime = JSON.stringify(fetchRequests)
  for (const token of [...fakeGitHub.installationTokens.keys(), ...fakeGitHub.userTokens()])
    expect(sentToRuntime).not.toContain(token)
  expect([
    ...(await database.$client`select tool, read_only, status from tool_calls where chat_id = ${id} order by called_at`),
  ]).toEqual([
    { tool: 'fetch_branch', read_only: true, status: 'succeeded' },
    { tool: 'fetch_branch', read_only: true, status: 'refused' },
  ])
})
