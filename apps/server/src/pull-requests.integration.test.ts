import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChatId, chatId } from '@spyria/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { createGitHubApi } from './github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './testing/fake-github.ts'
import {
  acme,
  alice,
  bob,
  lee,
  rpcOf,
  runtimeTurn,
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
const git = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Pi Agent', '-c', 'user.email=agent@example.com', ...command], {
    cwd,
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
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
  await waitFor(
    async () =>
      (await database.$client`select workspace_snapshot from runtimes where chat_id = ${id}`)[0]?.workspace_snapshot !=
      null,
    20_000,
  )
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
  expect([
    ...(await database.$client`select actor, payload->>'branch' as branch from events where chat_id = ${id} and type = 'branch.pushed'`),
  ]).toEqual([{ actor: alice, branch }])
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
    'update_pull_request',
    'fetch_branch',
    'read_review_threads',
    'read_checks',
    'list_issues',
    'read_issue',
  ])
  const initialized = await host.modelCall({
    path: '/mcp/github',
    headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
    body: rpcOf('initialize', { protocolVersion: '2025-06-18' }),
  })
  expect(JSON.parse(initialized.body).result.instructions).toStartWith(
    'This runtime has no GitHub credentials, by design',
  )
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

const toolResultsOf = (replies: { step?: unknown }[]) =>
  replies.flatMap(({ step }) => {
    const toolStep = step as { type?: string; name?: string; result?: string } | undefined
    return toolStep?.type === 'tool' ? [{ name: toolStep.name, result: toolStep.result }] : []
  })
type AgentHost = Awaited<ReturnType<typeof stack.agentHost>>['host']
const guestToolCall = async (host: AgentHost, token: string, name: string, input: object) => {
  const answer = await host.modelCall({
    path: '/mcp/github',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: rpcOf('tools/call', { name, arguments: input }),
  })
  const { result } = JSON.parse(answer.body)
  return { isError: result.isError, text: textOf(result) }
}

test('the owner’s agent changes the title and description of the open pull request and the card follows; with no open pull request, or on a guest’s turn, the change is refused', async () => {
  const { host } = await stack.agentHost('Pull request update host', { routesModelCalls: true })
  const { id } = await newDevChat()
  await committedWorkspace(id)
  await connectGitHub(alice)
  stack.setFakeLlmScript({ steps: [{ tool: 'update_pull_request', arguments: { title: 'Too early' } }], text: 'Done.' })
  expect(toolResultsOf(await promptAndWait(id, 'Retitle the pull request'))).toEqual([
    { name: 'update_pull_request', result: 'This chat has no open pull request: open one first' },
  ])
  expect((await publish(alice, id, 'pull_request', { title: 'Fix totals', body: 'First draft' })).status).toBe(200)
  const opened = fakeGitHub.pullRequests.at(-1)
  stack.setFakeLlmScript({
    steps: [{ tool: 'update_pull_request', arguments: { title: 'Fix the totals', body: 'Totals now add up.' } }],
    text: 'Updated.',
  })
  expect(toolResultsOf(await promptAndWait(id, 'Retitle the pull request'))).toEqual([
    {
      name: 'update_pull_request',
      result: `Updated pull request #${opened?.number}: ${fakeGitHub.urls.webUrl}/acme/app/pull/${opened?.number}`,
    },
  ])
  expect(fakeGitHub.pullRequests.at(-1)).toMatchObject({ title: 'Fix the totals', body: 'Totals now add up.' })
  expect((await cardOf(id))?.step).toMatchObject({ title: 'Fix the totals', state: 'open' })
  expect(fakeGitHub.apiRequests).toContain(`PATCH /repos/acme/app/pulls/${opened?.number}`)
  expect((await toolCallRows(id)).map(({ tool, read_only, status }) => ({ tool, read_only, status }))).toEqual([
    { tool: 'update_pull_request', read_only: false, status: 'refused' },
    { tool: 'update_pull_request', read_only: false, status: 'succeeded' },
  ])

  const guest = await runtimeTurn(host, bob)
  expect(await guestToolCall(host, guest.token, 'update_pull_request', { title: 'Guest' })).toEqual({
    isError: true,
    text: ownerOnly,
  })
})

test('any prompter’s agent reads review threads and issues of the chat’s repository with a read-only installation token, never the owner’s; a missing Issues permission is named', async () => {
  const { host } = await stack.agentHost('GitHub reads host', { routesModelCalls: true })
  const { id } = await newDevChat()
  await committedWorkspace(id)
  await connectGitHub(alice)
  expect((await publish(alice, id, 'pull_request', { title: 'Reviewed totals' })).status).toBe(200)
  const number = Number(fakeGitHub.pullRequests.at(-1)?.number)
  fakeGitHub.reviewThreads.push(
    {
      repository: 'acme/app',
      pullRequest: number,
      path: 'src/app.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      comments: [
        { author: 'rita', body: 'Use a constant.' },
        { author: 'alice-martin', body: 'On it.' },
      ],
    },
    {
      repository: 'acme/app',
      pullRequest: number,
      path: 'README.md',
      line: 3,
      isResolved: true,
      isOutdated: true,
      comments: [{ author: 'rita', body: 'Typo.' }],
    },
  )
  fakeGitHub.issues.push(
    {
      repository: 'acme/app',
      number: 41,
      title: 'Totals are wrong',
      body: 'The totals add one too many.',
      state: 'open',
      author: 'rita',
      labels: ['bug'],
      comments: [{ author: 'lee', body: 'Seen it too.' }],
      updatedAt: '2026-10-20T08:00:00Z',
    },
    {
      repository: 'acme/app',
      number: 42,
      title: 'Document the totals',
      body: '',
      state: 'closed',
      author: 'rita',
      labels: [],
      comments: [],
      updatedAt: '2026-10-21T08:00:00Z',
    },
  )
  const issuedBefore = new Set(fakeGitHub.installationTokens.keys())
  stack.setFakeLlmScript({
    steps: [
      { tool: 'read_review_threads' },
      { tool: 'list_issues', arguments: { labels: ['bug'], search: 'totals' } },
      { tool: 'read_issue', arguments: { number: 41 } },
    ],
    text: 'Read.',
  })
  expect(toolResultsOf(await promptAndWait(id, 'Read the reviews and the issues'))).toEqual([
    {
      name: 'read_review_threads',
      result: [
        `Pull request #${number}: 2 review threads, 1 unresolved`,
        '- src/app.ts:1 (unresolved)',
        '  rita: Use a constant.',
        '  alice-martin: On it.',
        '- README.md:3 (resolved, outdated)',
        '  rita: Typo.',
      ].join('\n'),
    },
    {
      name: 'list_issues',
      result: '#41 [open] Totals are wrong by rita, labels: bug, 1 comments, updated 2026-10-20',
    },
    {
      name: 'read_issue',
      result: [
        '#41 [open] Totals are wrong by rita, labels: bug, 1 comments, updated 2026-10-20',
        `${fakeGitHub.urls.webUrl}/acme/app/issues/41`,
        '',
        'The totals add one too many.',
        '',
        'Comments:',
        '  lee: Seen it too.',
      ].join('\n'),
    },
  ])
  expect(fakeGitHub.searches.at(-1)).toBe('repo:acme/app is:issue state:open label:"bug" totals')
  const readTokens = [...fakeGitHub.installationTokens.values()].filter(({ token }) => !issuedBefore.has(token))
  expect(readTokens.map(({ repositories, permissions }) => ({ repositories, permissions }))).toEqual([
    { repositories: ['app'], permissions: { pull_requests: 'read', metadata: 'read' } },
    { repositories: ['app'], permissions: { issues: 'read', metadata: 'read' } },
    { repositories: ['app'], permissions: { issues: 'read', metadata: 'read' } },
  ])
  expect(
    (await toolCallRows(id)).map(({ prompter_id, tool, read_only, status }) => ({
      prompter_id,
      tool,
      read_only,
      status,
    })),
  ).toEqual([
    { prompter_id: alice, tool: 'read_review_threads', read_only: true, status: 'succeeded' },
    { prompter_id: alice, tool: 'list_issues', read_only: true, status: 'succeeded' },
    { prompter_id: alice, tool: 'read_issue', read_only: true, status: 'succeeded' },
  ])

  const guest = await runtimeTurn(host, bob)
  await database.$client`
    update chats set repository = 'acme/app', base_branch = 'main', git_branch = 'spyria/guest-reads'
    where id = ${guest.chatId}`
  expect(await guestToolCall(host, guest.token, 'read_issue', { number: 41 })).toMatchObject({ isError: false })
  expect(await guestToolCall(host, guest.token, 'read_review_threads', {})).toEqual({
    isError: true,
    text: 'This chat has no pull request: give the number of the one to read',
  })
  expect(await guestToolCall(host, guest.token, 'read_review_threads', { number: 999 })).toEqual({
    isError: true,
    text: 'GitHub refused: Could not resolve to a PullRequest with the number of 999. (404)',
  })
  fakeGitHub.setInstallationPermissions({ contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' })
  try {
    expect(await guestToolCall(host, guest.token, 'list_issues', {})).toEqual({
      isError: true,
      text: "Ask a GitHub admin to accept the Issues permission for this workspace's GitHub App",
    })
  } finally {
    fakeGitHub.setInstallationPermissions()
  }
  expect(
    (await toolCallRows(guest.chatId)).map(({ prompter_id, tool, status }) => ({ prompter_id, tool, status })),
  ).toEqual([
    { prompter_id: bob, tool: 'read_issue', status: 'succeeded' },
    { prompter_id: bob, tool: 'read_review_threads', status: 'refused' },
    { prompter_id: bob, tool: 'read_review_threads', status: 'refused' },
    { prompter_id: bob, tool: 'list_issues', status: 'refused' },
  ])
})

test('any prompter’s agent reads the checks of a pull request’s head with read-only installation tokens, failing ones with the errors their CI annotated, the failed step and the end of its log; without the Actions permission the logs are left out and the permission is named; a pull request that does not exist is named', async () => {
  const { host } = await stack.agentHost('GitHub checks host', { routesModelCalls: true })
  const { id, branch } = await newDevChat()
  await committedWorkspace(id)
  await connectGitHub(alice)
  expect((await publish(alice, id, 'pull_request', { title: 'Checked totals' })).status).toBe(200)
  const number = Number(fakeGitHub.pullRequests.at(-1)?.number)
  const headSha = fakeGitHub.branchHeadOf('acme/app', branch)
  const firstRunId = fakeGitHub.checkRuns.length + 1
  const run = { repository: 'acme/app', headSha, annotations: [] }
  fakeGitHub.checkRuns.push(
    { ...run, name: 'lint', status: 'completed', conclusion: 'success' },
    {
      ...run,
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
      annotations: [
        {
          path: 'src/app.test.ts',
          line: 3,
          title: 'totals add up',
          message: 'Expected: 1\nReceived: 2',
        },
      ],
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Run bun test', conclusion: 'failure' },
        { name: 'Post Set up job', conclusion: 'success' },
      ],
      log: [
        '2026-10-28T20:00:00.0000001Z ##[group]Run bun install',
        '2026-10-28T20:00:00.0000002Z ##[endgroup]',
        '2026-10-28T20:00:00.0000003Z ##[group]Run bun test',
        '2026-10-28T20:00:00.0000004Z ##[endgroup]',
        '2026-10-28T20:00:00.0000005Z \u001b[31m1 fail\u001b[0m',
        '2026-10-28T20:00:00.0000006Z ##[error]Process completed with exit code 1.',
        '2026-10-28T20:00:00.0000007Z ##[group]Post Set up job',
      ].join('\r\n'),
    },
    { ...run, name: 'e2e', status: 'in_progress', conclusion: null },
    { ...run, name: 'preview', status: 'completed', conclusion: 'failure', app: 'vercel' },
    {
      ...run,
      headSha: '0000000000000000000000000000000000000000',
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
    },
  )
  const runUrlOf = (offset: number) => `${fakeGitHub.urls.webUrl}/acme/app/runs/${firstRunId + offset}`
  const issuedBefore = new Set(fakeGitHub.installationTokens.keys())
  stack.setFakeLlmScript({ steps: [{ tool: 'read_checks' }], text: 'Read.' })
  expect(toolResultsOf(await promptAndWait(id, 'Why does CI fail?'))).toEqual([
    {
      name: 'read_checks',
      result: [
        `Pull request #${number} at ${headSha.slice(0, 7)}: 4 checks, 2 failing, 1 pending, 1 passing`,
        `- unit: failure ${runUrlOf(1)}`,
        '  failed step: Run bun test',
        '  src/app.test.ts:3 failure: totals add up',
        '    Expected: 1',
        '    Received: 2',
        '  log:',
        '    Run bun test',
        '    1 fail',
        '    error: Process completed with exit code 1.',
        `- preview: failure ${runUrlOf(3)}`,
        `- e2e: pending ${runUrlOf(2)}`,
        `- lint: success ${runUrlOf(0)}`,
      ].join('\n'),
    },
  ])
  const readTokens = [...fakeGitHub.installationTokens.values()].filter(({ token }) => !issuedBefore.has(token))
  expect(readTokens.map(({ repositories, permissions }) => ({ repositories, permissions }))).toEqual([
    { repositories: ['app'], permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' } },
    { repositories: ['app'], permissions: { actions: 'read', metadata: 'read' } },
  ])
  expect(fakeGitHub.apiRequests.filter((line) => /annotations|actions/.test(line)).toSorted()).toEqual([
    `GET /repos/acme/app/actions/jobs/${firstRunId + 1}`,
    `GET /repos/acme/app/actions/jobs/${firstRunId + 1}/logs`,
    `GET /repos/acme/app/check-runs/${firstRunId + 1}/annotations`,
    `GET /repos/acme/app/check-runs/${firstRunId + 3}/annotations`,
  ])
  expect(
    (await toolCallRows(id)).map(({ prompter_id, tool, read_only, status }) => ({
      prompter_id,
      tool,
      read_only,
      status,
    })),
  ).toEqual([{ prompter_id: alice, tool: 'read_checks', read_only: true, status: 'succeeded' }])

  const guest = await runtimeTurn(host, bob)
  await database.$client`
    update chats set repository = 'acme/app', base_branch = 'main', git_branch = 'spyria/guest-checks'
    where id = ${guest.chatId}`
  expect(await guestToolCall(host, guest.token, 'read_checks', { number })).toMatchObject({ isError: false })
  fakeGitHub.setInstallationPermissions({ contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' })
  try {
    const { text } = await guestToolCall(host, guest.token, 'read_checks', { number })
    expect(text).toContain(
      "\nLogs not read: Ask a GitHub admin to accept the Actions permission for this workspace's GitHub App\n",
    )
    expect(text).toContain('  src/app.test.ts:3 failure: totals add up\n')
    expect(text).not.toContain('log:')
  } finally {
    fakeGitHub.setInstallationPermissions()
  }
  expect(await guestToolCall(host, guest.token, 'read_checks', {})).toEqual({
    isError: true,
    text: 'This chat has no pull request: give the number of the one to read',
  })
  expect(await guestToolCall(host, guest.token, 'read_checks', { number: 999 })).toEqual({
    isError: true,
    text: 'GitHub refused: acme/app has no pull request #999',
  })
})
