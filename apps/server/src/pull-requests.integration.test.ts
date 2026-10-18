import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChatId, chatId } from '@hq/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { createGitHubApi } from './github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './testing/fake-github.ts'
import {
  acme,
  alice,
  lee,
  rpcOf,
  runtimeTurn,
  bob,
  sessionTokenOf,
  startAgentStack,
  testSecretsKey,
  textOf,
  waitFor,
} from './testing/testing.ts'

setDefaultTimeout(40_000)
const fakeGitHub = startFakeGitHub()
const secretBox = createSecretBox(testSecretsKey)
const stack = await startAgentStack({ routing: true, github: { api: createGitHubApi(fakeGitHub.urls), secretBox } })
afterAll(() => fakeGitHub.stop())
const { app, database } = stack
const webhookSecret = 'whsec-pull-requests-0123'
const ownerOnly = 'Only Alice can push or open pull requests in this chat'

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
const publish = (userId: string, chat: ChatId, action: string, draft: object = {}) =>
  request(userId, 'POST', `/api/chats/${chat}/publish/${action}`, draft)
const git = (cwd: string, ...command: string[]) =>
  Bun.spawnSync(['git', '-c', 'user.name=Pi Agent', '-c', 'user.email=agent@example.com', ...command], { cwd })
const signatureOf = (body: string, secret = webhookSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const sendWebhook = async (
  event: string,
  payload: object,
  { delivery = crypto.randomUUID() as string, secret = webhookSecret } = {},
) => {
  const body = JSON.stringify(payload)
  const response = await app.request('/api/github/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-github-hook-installation-target-id': fakeGitHubAppId,
      'x-hub-signature-256': signatureOf(body, secret),
    },
    body,
  })
  return { status: response.status, body: await response.json() }
}
const cardOf = async (chat: ChatId) =>
  (
    await database.$client`
      select author_id, kind, step from messages where chat_id = ${chat} and step->>'type' = 'pull_request'`
  )[0]
const toolCallRows = async (chat: ChatId) => [
  ...(await database.$client`select prompter_id, owner_id, server, tool, read_only, decision, status from tool_calls where chat_id = ${chat}`),
]

expect(
  await request(alice, 'POST', '/api/github-settings', {
    appId: fakeGitHubAppId,
    clientId: fakeGitHubClientId,
    clientSecret: fakeGitHubClientSecret,
    privateKey: fakeGitHub.appPrivateKey,
    webhookSecret,
  }),
).toMatchObject({ status: 200 })

const connectGitHub = async (userId: string) => {
  const started = await request(userId, 'POST', '/api/github/connection/connect')
  const authorized = await fetch(started.body.authorizeUrl, { redirect: 'manual' })
  const callback = new URL(authorized.headers.get('location') ?? '')
  expect((await app.request(`${callback.pathname}${callback.search}`)).status).toBe(200)
  const [row] = await database.$client`
    select encrypted_access_token from github_connections where workspace_id = ${acme} and user_id = ${userId}`
  return secretBox.open(String(row?.encrypted_access_token))
}
const newDevChat = async (participants: { memberId: string; roleId: string }[] = []) => {
  const created = await request(alice, 'POST', '/api/dev-chats', {
    name: 'Fix totals',
    projectId: null,
    repository: 'acme/app',
    baseBranch: 'main',
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
const promptAndWait = async (id: ChatId, text: string) => {
  const promptId = await stack.prompt(id, text)
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  return stack.repliesTo(promptId, ['kind', 'body', 'step'])
}
const committedWorkspace = async (id: ChatId) => {
  await promptAndWait(id, 'stub:ls')
  const frames = (await stack.subscribedFrames(id)).map((frame) => JSON.parse(frame))
  const workspace = String(frames.find((frame) => frame.workspace)?.workspace.cwd)
  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 2\n')
  git(workspace, 'commit', '-qam', 'Fix the totals')
  return workspace
}

test('only the owner pushes and opens a pull request, with their own GitHub token passed only to git; guests and an owner without GitHub are refused', async () => {
  const { relay, launches } = await stack.agentHost('Pull request host', { routesModelCalls: true })
  const { id, branch } = await newDevChat([
    { memberId: bob, roleId: 'prompter' },
    { memberId: lee, roleId: 'editor' },
  ])
  const workspace = await committedWorkspace(id)

  expect(await publish(alice, id, 'push')).toEqual({
    status: 403,
    body: { isRefused: true, text: 'Connect your GitHub account in your profile to push' },
  })
  const aliceToken = await connectGitHub(alice)
  for (const guest of [bob, lee])
    for (const action of ['push', 'pull_request'])
      expect(await publish(guest, id, action)).toEqual({ status: 403, body: { isRefused: true, text: ownerOnly } })
  expect(fakeGitHub.commitSubjectsOf('acme/app', branch)).toEqual([])

  expect(await publish(alice, id, 'push')).toEqual({
    status: 200,
    body: { isRefused: false, text: `Pushed ${branch}` },
  })
  expect(fakeGitHub.commitSubjectsOf('acme/app', branch)).toEqual(['Fix the totals'])
  expect(await cardOf(id)).toBeUndefined()
  const opened = await publish(alice, id, 'pull_request', { title: 'Fix the totals', body: 'Totals now add up.' })
  expect(opened).toEqual({
    status: 200,
    body: { isRefused: false, text: `Opened pull request #1: ${fakeGitHub.urls.webUrl}/acme/app/pull/1` },
  })
  expect(fakeGitHub.pullRequests).toEqual([
    {
      repository: 'acme/app',
      number: 1,
      title: 'Fix the totals',
      body: 'Totals now add up.',
      head: branch,
      base: 'main',
      authorToken: aliceToken,
    },
  ])
  expect(await cardOf(id)).toEqual({
    author_id: alice,
    kind: 'step',
    step: {
      type: 'pull_request',
      repository: 'acme/app',
      number: 1,
      url: `${fakeGitHub.urls.webUrl}/acme/app/pull/1`,
      title: 'Fix the totals',
      state: 'open',
      headSha: fakeGitHub.branchHeadOf('acme/app', branch),
      commits: 1,
      checks: {},
      review: null,
      comments: [],
    },
  })
  const [posted] = await database.$client`
    select actor, payload from events where chat_id = ${id} and type = 'message.posted' and payload->>'kind' = 'step'`
  expect(posted).toMatchObject({ actor: alice, payload: { step: { type: 'pull_request', number: 1 } } })

  writeFileSync(join(workspace, 'src/app.ts'), 'export const total = 3\n')
  git(workspace, 'commit', '-qam', 'Address the review')
  expect((await publish(alice, id, 'pull_request')).body.text).toBe(
    `Pushed ${branch} to pull request #1 (2 commits): ${fakeGitHub.urls.webUrl}/acme/app/pull/1`,
  )
  expect(fakeGitHub.pullRequests).toHaveLength(1)
  expect((await cardOf(id))?.step.commits).toBe(2)
  const [changed] =
    await database.$client`select actor, payload from events where chat_id = ${id} and type = 'message.step_changed'`
  expect(changed).toMatchObject({ actor: alice, payload: { step: { commits: 2 } } })

  expect(relay.requests.some(({ path }) => path === '/api/workspace/bundle')).toBe(true)
  expect(JSON.stringify(relay.requests)).not.toContain(aliceToken)
  expect(readFileSync(join(workspace, '.git/config'), 'utf8')).not.toContain(aliceToken)
  expect(
    launches()
      .find((launch) => !launch.parent_conversation_id)
      ?.agent.acp_command.join(' '),
  ).toContain('/mcp/github')
})

test('the server pushes the runtime’s bundle itself: a hostile git config in the runtime neither redirects the push nor sees the owner’s token', async () => {
  const { relay } = await stack.agentHost('Hostile config host', { routesModelCalls: true })
  const { id, branch } = await newDevChat()
  const workspace = await committedWorkspace(id)
  const aliceToken = await connectGitHub(alice)
  const hostileRequests: string[] = []
  const hostile = Bun.serve({
    port: 0,
    fetch: (request) => {
      hostileRequests.push(`${request.method} ${request.url} ${request.headers.get('authorization')}`)
      return new Response('Not found', { status: 404 })
    },
  })
  const helperOutput = join(workspace, '..', 'credential-helper-output')
  const hostileConfig = `[url "http://localhost:${hostile.port}/"]\n\tinsteadOf = ${fakeGitHub.urls.webUrl}/\n[http]\n\textraHeader = X-Hostile: 1\n[credential]\n\thelper = "!f() { cat >> ${helperOutput}; }; f"\n[core]\n\thooksPath = ${workspace}/.git/hooks\n`
  for (const config of [join(workspace, '.git/config'), join(workspace, '..', '.gitconfig')])
    writeFileSync(config, `${existsSync(config) ? readFileSync(config, 'utf8') : ''}${hostileConfig}`)
  try {
    expect(await publish(alice, id, 'push')).toEqual({
      status: 200,
      body: { isRefused: false, text: `Pushed ${branch}` },
    })
    expect(fakeGitHub.commitSubjectsOf('acme/app', branch)).toEqual(['Fix the totals'])
    expect(hostileRequests).toEqual([])
    expect(existsSync(helperOutput)).toBe(false)
    expect(JSON.stringify(relay.requests)).not.toContain(aliceToken)
    expect(
      relay.requests.filter(({ path }) => path === '/api/workspace/bundle').map(({ body }) => JSON.parse(String(body))),
    ).toEqual([{ branch, prerequisite: fakeGitHub.branchHeadOf('acme/app', 'main') }])
  } finally {
    await hostile.stop(true)
  }
})

test('the agent pushes and opens a pull request with its tools on the owner’s turn; on a guest’s turn the tools are refused and every call is audited', async () => {
  const { host } = await stack.agentHost('Agent tools host', { routesModelCalls: true })
  const { id } = await newDevChat()
  await committedWorkspace(id)
  await connectGitHub(alice)
  stack.setFakeLlmScript({
    steps: [{ tool: 'open_pull_request', arguments: { title: 'Agent totals', body: 'Opened by the agent.' } }],
    text: 'The pull request is open.',
  })
  const replies = await promptAndWait(id, 'Open a pull request')
  const toolStep = replies.find((reply) => reply.step?.type === 'tool')?.step as { name?: string; result?: string }
  expect(toolStep).toMatchObject({ name: 'open_pull_request' })
  expect(toolStep?.result).toStartWith('Opened pull request #')
  expect((await cardOf(id))?.step).toMatchObject({ title: 'Agent totals', state: 'open' })
  expect(fakeGitHub.pullRequests.at(-1)).toMatchObject({ title: 'Agent totals', body: 'Opened by the agent.' })
  expect(await toolCallRows(id)).toEqual([
    {
      prompter_id: alice,
      owner_id: alice,
      server: 'github',
      tool: 'open_pull_request',
      read_only: false,
      decision: 'not_needed',
      status: 'succeeded',
    },
  ])

  const guest = await runtimeTurn(host, bob)
  for (const tool of ['push_branch', 'open_pull_request']) {
    const answer = await host.modelCall({
      path: '/mcp/github',
      headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
      body: rpcOf('tools/call', { name: tool, arguments: { title: 'Guest' } }),
    })
    const { result } = JSON.parse(answer.body)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(ownerOnly)
  }
  expect(
    (await toolCallRows(guest.chatId)).map(({ prompter_id, tool, status }) => ({ prompter_id, tool, status })),
  ).toEqual([
    { prompter_id: bob, tool: 'push_branch', status: 'refused' },
    { prompter_id: bob, tool: 'open_pull_request', status: 'refused' },
  ])
  const listed = await host.modelCall({
    path: '/mcp/github',
    headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
    body: rpcOf('tools/list'),
  })
  expect(JSON.parse(listed.body).result.tools.map(({ name }: { name: string }) => name)).toEqual([
    'push_branch',
    'open_pull_request',
  ])
})

test('signed webhooks update the card’s checks, review, comments and state; a bad signature, a duplicate delivery and an unknown pull request change nothing', async () => {
  await stack.agentHost('Webhook host', { routesModelCalls: true })
  const { id, branch } = await newDevChat()
  await committedWorkspace(id)
  await connectGitHub(alice)
  const opened = await publish(alice, id, 'pull_request', { title: 'Webhook totals', body: '' })
  const number = Number(/#(\d+)/.exec(opened.body.text)?.[1])
  const headSha = fakeGitHub.branchHeadOf('acme/app', branch)
  const repository = { full_name: 'acme/app' }
  const suite = (conclusion: string) => ({
    action: 'completed',
    repository,
    check_suite: { id: 5, head_sha: headSha, conclusion, pull_requests: [{ number }] },
  })
  const stepOf = async () => (await cardOf(id))?.step

  expect(await sendWebhook('check_suite', suite('success'), { secret: 'wrong' })).toEqual({
    status: 401,
    body: { outcome: 'refused' },
  })
  expect((await stepOf()).checks).toEqual({})
  expect(await sendWebhook('check_suite', suite('success'), { delivery: 'delivery-1' })).toEqual({
    status: 200,
    body: { outcome: 'applied' },
  })
  expect((await stepOf()).checks).toEqual({ 'check_suite:5': 'passing' })
  expect(await sendWebhook('check_suite', suite('failure'), { delivery: 'delivery-1' })).toEqual({
    status: 200,
    body: { outcome: 'duplicate' },
  })
  expect((await stepOf()).checks).toEqual({ 'check_suite:5': 'passing' })
  const unknown = {
    ...suite('failure'),
    check_suite: { ...suite('failure').check_suite, pull_requests: [{ number: 999 }] },
  }
  expect(await sendWebhook('check_suite', unknown)).toEqual({ status: 202, body: { outcome: 'ignored' } })
  expect(await sendWebhook('ping', { zen: 'Keep it simple.' })).toEqual({ status: 202, body: { outcome: 'ignored' } })

  const pullRequest = { number, html_url: (await stepOf()).url, title: 'Webhook totals', head: { sha: headSha } }
  const reviewed = { action: 'submitted', repository, pull_request: { ...pullRequest, state: 'open' } }
  await sendWebhook('pull_request_review', { ...reviewed, review: { state: 'changes_requested' } })
  for (const [commentId, line] of [
    [41, 1],
    [42, 2],
  ] as const)
    await sendWebhook('pull_request_review_comment', {
      action: 'created',
      repository,
      pull_request: { ...pullRequest, state: 'open' },
      comment: { id: commentId, path: 'src/app.ts', line, user: { login: 'rita' }, body: `Comment ${commentId}` },
    })
  expect(await stepOf()).toMatchObject({
    review: 'changes_requested',
    comments: [
      { id: 41, path: 'src/app.ts', line: 1, author: 'rita', body: 'Comment 41', isResolved: false },
      { id: 42, path: 'src/app.ts', line: 2, author: 'rita', body: 'Comment 42', isResolved: false },
    ],
    checks: { 'check_suite:5': 'passing' },
  })
  await sendWebhook('pull_request', {
    action: 'closed',
    repository,
    pull_request: { ...pullRequest, state: 'closed', merged: true, commits: 1 },
  })
  expect(await stepOf()).toMatchObject({ state: 'merged', review: 'changes_requested' })
  const stepChanges = await database.$client`
    select count(*)::int as count from events where chat_id = ${id} and type = 'message.step_changed'`
  expect(stepChanges[0]?.count).toBe(5)
})
