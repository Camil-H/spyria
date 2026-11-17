import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatId } from '@spyria/kernel'
import { gitIn, startGitHubStack } from './testing/github-stack.ts'
import { acme, alice, bob, sessionTokenOf, succeeded, waitFor } from './testing/testing.ts'

setDefaultTimeout(30_000)
const { stack, request, configureGitHubApp, newDevChat, promptAndWait, workspaceOf, snapshotOf, runtimeWorkspaceOf } =
  await startGitHubStack({ llm: { model: 'openai/mistral/codestral-latest' } })
const { app, database } = stack

const read = (userId: string, chat: ChatId, kind: string, path = '') =>
  request(userId, 'GET', `/api/chats/${chat}/workspace/${kind}?${new URLSearchParams({ path })}`)

await configureGitHubApp('whsec-dev-panel-0123')

test('a dev chat reads its tree, files, changes against base and commits through spyria-agent, for readers only, with caps', async () => {
  await stack.agentHost('panel host')
  const { id } = await newDevChat()
  const { workspace } = await runtimeWorkspaceOf(id)
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 2\n')
  gitIn(workspace, 'commit', '-qam', 'Fix the totals')
  writeFileSync(join(workspace, 'src/new.ts'), 'export const added = true\n')

  expect(await read(alice, id, 'tree')).toEqual({
    status: 200,
    body: {
      isLive: true,
      entries: [
        { name: 'src', path: 'src', isFolder: true },
        { name: 'AGENTS.md', path: 'AGENTS.md', isFolder: false },
        { name: 'only-in-acme-app.txt', path: 'only-in-acme-app.txt', isFolder: false },
        { name: 'README.md', path: 'README.md', isFolder: false },
      ],
      truncated: false,
    },
  })
  expect((await read(alice, id, 'tree', 'src')).body.entries.map(({ path }: { path: string }) => path)).toEqual([
    'src/app.ts',
    'src/new.ts',
  ])
  expect((await read(alice, id, 'file', 'README.md')).body).toEqual({
    isLive: true,
    content: '# acme app\n',
    isBinary: false,
    truncated: false,
  })
  expect((await read(alice, id, 'file', '../../etc/hosts')).body).toEqual({ isLive: false })
  const changes = (await read(alice, id, 'changes')).body
  expect(changes.isLive).toBe(true)
  expect(changes.files).toContain('M\0src/app.ts\0')
  expect(changes.files).toContain('A\0src/new.ts\0')
  expect(changes.unstaged).toContain('diff --git a/src/new.ts b/src/new.ts')
  const commits = (await read(alice, id, 'commits')).body
  expect(commits).toMatchObject({ isLive: true, hasMoreCommits: false, truncated: false })
  expect(String(commits.log).split('\0').slice(1, 3)).toEqual(['Fix the totals', 'Pi Agent'])
  expect(commits.commitPatches).toContain('-export const total = 1\n+export const total = 2')
  expect((await request(alice, 'GET', `/api/chats/${id}/workspace/remove`)).status).toBe(400)

  for (const kind of ['tree', 'file', 'changes', 'commits'])
    expect((await read(bob, id, kind, 'README.md')).status).toBe(403)
  expect((await request(bob, 'POST', `/api/chats/${id}/workspace/wake`)).status).toBe(403)
  await database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${bob}, 'reader')`
  expect((await read(bob, id, 'file', 'README.md')).body.content).toBe('# acme app\n')
  expect((await request(bob, 'POST', `/api/chats/${id}/workspace/wake`)).status).toBe(403)

  writeFileSync(join(workspace, 'large.txt'), 'x\n'.repeat(250_000))
  expect((await read(alice, id, 'changes')).body).toMatchObject({ truncated: true, cut: ['unstaged'] })
  const compressed = await app.request(`/api/chats/${id}/workspace/changes`, {
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}`,
      'accept-encoding': 'gzip',
    },
  })
  expect(compressed.headers.get('content-encoding')).toBe('gzip')
  const unzipped = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await compressed.bytes())))
  expect(unzipped).toMatchObject({ isLive: true, truncated: true, cut: ['unstaged'] })
})

test('a file the agent made is shown inline through the server, only to readers, only as allowed media from inside the workspace', async () => {
  await stack.agentHost('media host')
  const { id } = await newDevChat()
  await promptAndWait(id, 'stub:ls')
  const workspace = await workspaceOf(id)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  mkdirSync(join(workspace, 'out'), { recursive: true })
  writeFileSync(join(workspace, 'out/sales chart.png'), png)
  writeFileSync(join(workspace, 'out/page.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
  const media = async (userId: string, path: string) =>
    app.request(`/api/chats/${id}/media?${new URLSearchParams({ path })}`, {
      headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
    })

  const shown = await media(alice, 'out/sales chart.png')
  expect(shown.status).toBe(200)
  expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png)
  expect(Object.fromEntries(shown.headers)).toEqual(
    expect.objectContaining({
      'content-type': 'image/png',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-cache',
    }),
  )
  expect((await media(alice, join(workspace, 'out/sales chart.png'))).status).toBe(200)
  expect((await media(alice, 'out/page.svg')).status).toBe(415)
  for (const refused of ['../../etc/hosts', '/etc/hosts', 'missing.png', 'https://example.com/a.png'])
    expect((await media(alice, refused)).status).toBe(404)
  expect((await media(bob, 'out/sales chart.png')).status).toBe(403)
})

test('an asleep runtime serves the snapshot of the last turn end, a read never wakes it, and Wake starts it again', async () => {
  const { host, relay } = await stack.agentHost('sleep host')
  const { id } = await newDevChat()
  const { workspace } = await runtimeWorkspaceOf(id)
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 3\n')
  gitIn(workspace, 'commit', '-qam', 'Raise the totals')
  await promptAndWait(id, 'stub:ls')
  await waitFor(async () => String(await snapshotOf(id)).includes('export const total = 3'))

  const runtime = await stack.runtimeOf(id)
  const container = host.containers.get(String(runtime.id))
  if (container) {
    container.running = false
    relay.containerAgent.stopped(container)
  }
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${id}`
  const tree = (await read(alice, id, 'tree')).body
  expect(tree.isLive).toBe(false)
  expect(tree.entries.map(({ path }: { path: string }) => path)).toEqual([
    'src',
    'AGENTS.md',
    'only-in-acme-app.txt',
    'README.md',
  ])
  expect((await read(alice, id, 'changes')).body).toMatchObject({
    isLive: false,
    files: expect.stringContaining('M\0src/app.ts\0'),
  })
  expect((await read(alice, id, 'commits')).body).toMatchObject({
    isLive: false,
    log: expect.stringContaining('Raise the totals'),
  })
  expect((await read(alice, id, 'tree', 'src')).body).toEqual({ isLive: false })
  expect((await read(alice, id, 'file', 'README.md')).body).toEqual({ isLive: false })
  expect((await stack.runtimeOf(id)).state).toBe('stopped')
  expect(await stack.jobStatesOf('runtime.start', { runtimeId: runtime.id })).toEqual([])

  expect((await request(alice, 'POST', `/api/chats/${id}/workspace/wake`)).status).toBe(204)
  await waitFor(async () => (await stack.runtimeOf(id)).state === 'running', 15_000)
  expect((await read(alice, id, 'file', 'src/app.ts')).body).toMatchObject({
    isLive: true,
    content: 'export const total = 3\n',
  })
})

test('a slow .spyria/setup.sh no longer holds the launch past the relay limit: the session answers, the setup streams as a command step and its failure stays a notice', async () => {
  await stack.agentHost('slow setup host', { relayLimitMilliseconds: 2000 })
  expect(
    await stack.mutate({ workspaceId: acme, userId: alice }, 'workspace.setSetupCommands', {
      workspaceId: acme,
      commands: [{ repository: 'acme/docs', command: 'sh .spyria/setup.sh' }],
    }),
  ).toEqual(succeeded)
  const { id } = await newDevChat({ repository: 'acme/docs' })
  const { frames } = await stack.openStream(id)
  const replies = await promptAndWait(id, 'stub:ls')
  expect(replies.map(({ body }) => body).join('')).toContain('files:.git,.spyria,README.md')
  await waitFor(
    async () => (await database.$client`select 1 from messages where chat_id = ${id} and kind = 'notice'`).length > 0,
    15_000,
  )
  const setupStep = (
    await database.$client`
    select step from messages where chat_id = ${id} and step->>'type' = 'command'`
  )[0]?.step
  expect(setupStep).toMatchObject({
    command: 'sh .spyria/setup.sh',
    exitCode: 127,
    output: 'installing the docs toolchain\ndocs-tool: command not found\n',
  })
  const liveOutputs = frames.map((frame) => JSON.parse(frame).commandOutput).filter(Boolean)
  expect(liveOutputs[0]).toEqual({
    stepId: expect.stringMatching(/:spyria-setup$/),
    output: 'installing the docs toolchain\n',
  })
  expect(
    (await database.$client`select body from messages where chat_id = ${id} and kind = 'notice'`).map(
      ({ body }) => body,
    ),
  ).toEqual([
    'The setup command "sh .spyria/setup.sh" failed with exit code 127; the session started anyway.\ninstalling the docs toolchain\ndocs-tool: command not found',
  ])
})
