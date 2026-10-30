import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatId } from '@spyria/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { appJwtOf, createGitHubApi } from './github/github-api.ts'
import {
  fakeGitHubAppId,
  fakeGitHubClientId,
  fakeGitHubClientSecret,
  fakeGitHubLogin,
  startFakeGitHub,
} from './testing/fake-github.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  captureLogs,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  testSecretsKey,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'

const fakeGitHub = startFakeGitHub()
const secretBox = createSecretBox(testSecretsKey)
const stack = await startAgentStack({
  llm: { model: 'openai/mistral/codestral-latest' },
  github: { api: createGitHubApi(fakeGitHub.urls), secretBox },
})
afterAll(() => fakeGitHub.stop())
const { app, database } = stack
const webhookSecret = 'whsec-integration-0123'
const appSettings = {
  appId: fakeGitHubAppId,
  clientId: fakeGitHubClientId,
  clientSecret: fakeGitHubClientSecret,
  privateKey: fakeGitHub.appPrivateKey,
  webhookSecret,
}

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
  return { status: response.status, text, body: text ? JSON.parse(text) : null }
}
const appRow = async () =>
  (await database.$client`select * from github_apps where workspace_id = ${acme}`)[0] as Record<string, string>
const connectionRow = async () =>
  (await database.$client`select * from github_connections where workspace_id = ${acme} and user_id = ${alice}`)[0]
const githubEvents = async () => (await workspaceEventsOf(database)).filter(({ type }) => type.startsWith('github.'))

test('GitHub App settings: admins only, secrets required at first, sealed at rest, never returned, rotations recorded, refused credentials refused, configured readable without secrets', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/github-settings'],
    ['POST', '/api/github-settings', appSettings],
    ['GET', '/api/github-settings/configured'],
  ] as const)
    expect(await request(bob, method, path, body)).toMatchObject({
      status: 403,
      body: {
        error: 'missing_workspace_permission',
        message: 'Your workspace role does not allow this: Connect GitHub',
      },
    })
  expect(await request(alice, 'GET', '/api/github-settings')).toMatchObject({ status: 200, body: { settings: null } })
  expect(await request(alice, 'GET', '/api/github-settings/configured')).toEqual({
    status: 200,
    text: '{"configured":false}',
    body: { configured: false },
  })
  expect(await request(alice, 'POST', '/api/github-settings', { ...appSettings, webhookSecret: '' })).toMatchObject({
    status: 400,
    body: { error: 'invalid_github_settings', message: 'A webhook secret is required' },
  })
  expect(
    await request(alice, 'POST', '/api/github-settings', { ...appSettings, privateKey: 'not a key' }),
  ).toMatchObject({ status: 400, body: { message: 'The private key is not a PEM key' } })
  expect(await request(alice, 'POST', '/api/github-settings', { ...appSettings, appId: '999' })).toMatchObject({
    status: 422,
    body: { error: 'github_refused', message: 'GitHub refused: Bad credentials (401)' },
  })
  expect(await appRow()).toBeUndefined()

  const saved = await request(alice, 'POST', '/api/github-settings', appSettings)
  expect(saved).toMatchObject({ status: 200 })
  expect(saved.body.settings).toEqual({
    appId: fakeGitHubAppId,
    clientId: fakeGitHubClientId,
    repositories: [
      { fullName: 'acme/app', defaultBranch: 'main' },
      { fullName: 'acme/docs', defaultBranch: 'main' },
    ],
    listingFailure: null,
  })
  const read = await request(alice, 'GET', '/api/github-settings')
  expect(await request(alice, 'GET', '/api/github-settings/configured')).toEqual({
    status: 200,
    text: '{"configured":true}',
    body: { configured: true },
  })
  for (const secret of [fakeGitHubClientSecret, webhookSecret, 'PRIVATE KEY'])
    for (const shown of [saved.text, read.text]) expect(shown).not.toContain(secret)
  const sealed = await appRow()
  expect(JSON.stringify(sealed)).not.toContain(webhookSecret)
  expect(JSON.stringify(sealed)).not.toContain('PRIVATE KEY')
  expect(await secretBox.open(sealed.encrypted_webhook_secret ?? '')).toBe(webhookSecret)
  expect(await secretBox.open(sealed.encrypted_private_key ?? '')).toBe(fakeGitHub.appPrivateKey.trim())

  expect(
    await request(alice, 'POST', '/api/github-settings', {
      appId: fakeGitHubAppId,
      clientId: fakeGitHubClientId,
      webhookSecret: 'whsec-rotated',
    }),
  ).toMatchObject({ status: 200 })
  const rotated = await appRow()
  expect(await secretBox.open(rotated.encrypted_webhook_secret ?? '')).toBe('whsec-rotated')
  expect(rotated.encrypted_private_key).toBe(sealed.encrypted_private_key ?? '')
  expect((await githubEvents()).map(({ type, actorId, payload }) => ({ type, actorId, payload }))).toEqual([
    { type: 'github.configured', actorId: alice, payload: { appId: fakeGitHubAppId, clientId: fakeGitHubClientId } },
    { type: 'github.secret_rotated', actorId: alice, payload: { secrets: ['webhookSecret'] } },
  ])
})

test('a member connects GitHub through the user OAuth: tokens sealed server-side, refreshed when expired, Needs reconnection when the refresh fails', async () => {
  expect(await request(alice, 'GET', '/api/github/connection')).toMatchObject({ body: { connection: null } })
  const started = await request(alice, 'POST', '/api/github/connection/connect')
  const authorizeUrl = new URL(started.body.authorizeUrl)
  expect(authorizeUrl.origin).toBe(fakeGitHub.urls.webUrl)
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:5190/auth/github/callback')
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' })
  const callback = new URL(authorized.headers.get('location') ?? '')
  const tampered = await app.request(`${callback.pathname}?code=${callback.searchParams.get('code')}&state=x.y`)
  expect(tampered.status).toBe(400)
  const page = await app.request(`${callback.pathname}${callback.search}`)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('GitHub is connected')
  expect(await request(alice, 'GET', '/api/github/connection')).toMatchObject({
    body: { connection: { login: fakeGitHubLogin, state: 'connected' } },
  })
  const stored = await connectionRow()
  expect(stored?.encrypted_access_token).not.toStartWith('ghu_')
  expect(await secretBox.open(stored?.encrypted_access_token)).toStartWith('ghu_')
  expect(await secretBox.open(stored?.encrypted_refresh_token)).toStartWith('ghr_')
  expect(await request(bob, 'GET', '/api/github/connection')).toMatchObject({ body: { connection: null } })

  await database.$client`update github_connections set access_expires_at = now() - interval '1 minute'`
  expect(await request(alice, 'GET', '/api/github/connection')).toMatchObject({
    body: { connection: { state: 'connected' } },
  })
  const refreshed = await connectionRow()
  expect(await secretBox.open(refreshed?.encrypted_access_token)).not.toBe(
    await secretBox.open(stored?.encrypted_access_token),
  )
  expect(new Date(refreshed?.access_expires_at).getTime()).toBeGreaterThan(Date.now())

  fakeGitHub.revokeRefreshTokens()
  await database.$client`update github_connections set access_expires_at = now() - interval '1 minute'`
  expect(await request(alice, 'GET', '/api/github/connection')).toMatchObject({
    body: { connection: { login: fakeGitHubLogin, state: 'needs_reconnection' } },
  })
  expect(await request(alice, 'POST', '/api/github/connection/disconnect')).toMatchObject({ status: 200 })
  expect(await connectionRow()).toBeUndefined()
})

test('a dev chat needs a granted repository and an existing base branch, and stores its working branch', async () => {
  const withGitHubCalls = async <Result>(action: () => Promise<Result>) => {
    const callsBefore = fakeGitHub.apiRequests.length
    const result = await action()
    return { result, githubCalls: fakeGitHub.apiRequests.slice(callsBefore) }
  }
  const branchesCalls = (repository: string) => [
    `GET /repos/${repository}/installation`,
    'POST /app/installations/77/access_tokens',
    `GET /repos/${repository}/branches`,
  ]
  expect(await request(bob, 'GET', '/api/github/repositories')).toMatchObject({
    body: { repositories: [{ fullName: 'acme/app' }, { fullName: 'acme/docs' }] },
  })
  expect(await withGitHubCalls(() => request(bob, 'GET', '/api/github/branches?repository=acme/app'))).toMatchObject({
    result: { body: { branches: ['main', 'release'] } },
    githubCalls: branchesCalls('acme/app'),
  })
  for (const outside of ['acme/../app', 'acme/secret', ''])
    expect(
      await withGitHubCalls(() =>
        request(bob, 'GET', `/api/github/branches?${new URLSearchParams({ repository: outside })}`),
      ),
    ).toMatchObject({
      result: { status: 400, body: { error: 'repository_not_granted' } },
      githubCalls: outside === 'acme/secret' ? ['GET /repos/acme/secret/installation'] : [],
    })
  const devChat = (repository: string, baseBranch: string) =>
    request(alice, 'POST', '/api/dev-chats', { name: 'Fix the totals', projectId: null, repository, baseBranch })
  expect(await devChat('acme/secret', 'main')).toMatchObject({
    status: 400,
    body: { error: 'repository_not_granted', message: "acme/secret is not granted to the workspace's GitHub App" },
  })
  expect(await devChat('acme/app', 'gone')).toMatchObject({
    status: 400,
    body: { error: 'branch_not_found', message: 'acme/app has no branch gone' },
  })
  const { result: created, githubCalls } = await withGitHubCalls(() => devChat('acme/app', 'release'))
  expect(githubCalls).toEqual(branchesCalls('acme/app'))
  expect(created.status).toBe(201)
  const id = String(created.body.chatId)
  expect(await stack.chatRow(id)).toMatchObject({
    type: 'runtime',
    visibility: 'private',
    mode: 'dev',
    repository: 'acme/app',
    baseBranch: 'release',
    gitBranch: `spyria/fix-the-totals-${id.replace(/-/g, '').slice(0, 6)}`,
    ownerUserId: alice,
  })
  expect((await stack.changesOf(id))[0]).toMatchObject({
    type: 'chat.created',
    payload: { repository: 'acme/app', baseBranch: 'release' },
  })
  const publicChat = await request(alice, 'POST', '/api/dev-chats', {
    name: 'Share the totals',
    projectId: null,
    repository: 'acme/app',
    baseBranch: 'release',
    visibility: 'public',
  })
  expect(await stack.chatRow(String(publicChat.body.chatId))).toMatchObject({ mode: 'dev', visibility: 'public' })
})

test('GitHub enforces token permissions: branches need contents read; a refusal answers 422 with GitHub reason and logs one github.refused line without secrets', async () => {
  const api = createGitHubApi(fakeGitHub.urls)
  const jwt = appJwtOf(fakeGitHubAppId, fakeGitHub.appPrivateKey)
  const metadataOnly = await api.installationToken(jwt, 77, {
    repositories: ['app'],
    permissions: { metadata: 'read' },
  })
  await expect(api.branches(metadataOnly, 'acme/app')).rejects.toMatchObject({
    status: 403,
    message: 'Resource not accessible by integration (403)',
  })
  const logs = captureLogs()
  fakeGitHub.setInstallationPermissions({ metadata: 'read', pull_requests: 'write' })
  try {
    expect(await request(bob, 'GET', '/api/github/branches?repository=acme/app')).toMatchObject({
      status: 422,
      body: {
        error: 'github_refused',
        message: 'GitHub refused: The permissions requested are not granted to this installation. (422)',
      },
    })
  } finally {
    fakeGitHub.setInstallationPermissions()
    logs.restore()
  }
  const refusals = logs.events.filter(({ event }) => event === 'github.refused')
  expect(refusals).toEqual([
    {
      severity: 'WARN',
      event: 'github.refused',
      body: 'GitHub refused a request',
      attributes: {
        'workspace.id': acme,
        'http.request.method': 'POST',
        'url.path': '/app/installations/77/access_tokens',
        'http.response.status_code': 422,
        'github.message': 'The permissions requested are not granted to this installation.',
      },
    },
  ])
  expect(JSON.stringify(logs.events)).not.toMatch(/ghs_|eyJ/)
  expect(await request(bob, 'GET', '/api/github/branches?repository=acme/app')).toMatchObject({
    status: 200,
    body: { branches: ['main', 'release'] },
  })
})

const devChatAndPrompt = async (repository: string, text: string) => {
  const created = await request(alice, 'POST', '/api/dev-chats', {
    name: 'Clone check',
    projectId: null,
    repository,
    baseBranch: 'main',
  })
  const id = chatId(String(created.body.chatId))
  await stack.mutate({ workspaceId: acme, userId: alice }, 'conversation.updateChatRouting', {
    workspaceId: acme,
    chatId: id,
    runsOn: 'runtime',
  })
  const promptId = await stack.prompt(id, text)
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 15_000)
  return { id, promptId, replies: await stack.repliesTo(promptId) }
}

test('a dev chat clones its repository with a read-only installation token kept out of the agent and the repository config, on the working branch; a failing setup script shows a notice and the session still answers', async () => {
  const { launches } = await stack.agentHost('repos host')
  const { id, replies } = await devChatAndPrompt('acme/app', 'stub:ls stub:env')
  const { gitBranch } = (await stack.chatRow(id)) ?? {}
  const answer = replies.map(({ body }) => body).join('')
  expect(answer).toContain('files:.git,AGENTS.md,README.md,only-in-acme-app.txt,src')
  const [launch] = launches() as unknown as { repository: Record<string, unknown>; secrets: object }[]
  expect(launch?.repository).toEqual({
    url: `${fakeGitHub.urls.webUrl}/acme/app.git`,
    token: expect.stringMatching(/^ghs_/),
    base_branch: 'main',
    working_branch: String(gitBranch),
    author: { name: 'Alice', email: `${alice}@users.noreply.spyria` },
  })
  const token = String(launch?.repository.token ?? '')
  expect(fakeGitHub.installationTokens.get(token)).toMatchObject({
    repositories: ['app'],
    permissions: { contents: 'read' },
  })
  expect(fakeGitHub.gitAuthorizations).toContain(token)
  expect(JSON.stringify(launch?.secrets)).not.toContain(token)
  expect(answer).not.toContain('GIT_CONFIG')
  const frames = await stack.subscribedFrames(id)
  const workspaceFrame = frames.map((frame) => JSON.parse(frame)).find((frame) => frame.workspace)
  expect(workspaceFrame?.workspace.branch).toBe(gitBranch)
  const gitConfig = readFileSync(join(String(workspaceFrame?.workspace.cwd), '.git/config'), 'utf8')
  expect(gitConfig).not.toContain(token)
  expect(gitConfig).not.toContain('extraHeader')
  expect(gitConfig).toContain(`url = ${fakeGitHub.urls.webUrl}/acme/app.git`)
  expect(gitConfig).toContain(`name = Alice\n\temail = ${alice}@users.noreply.spyria`)

  const failing = await devChatAndPrompt('acme/docs', 'stub:ls')
  expect(failing.replies.map(({ body }) => body).join('')).toContain('files:.git,.spyria,README.md')
  const notices = async () => (await stack.repliesTo(failing.promptId)).filter(({ kind }) => kind === 'notice')
  await waitFor(async () => (await notices()).length > 0, 15_000)
  expect(await notices()).toEqual([
    {
      kind: 'notice',
      body: 'The setup command "sh .spyria/setup.sh" failed with exit code 127; the session started anyway.\ninstalling the docs toolchain\ndocs-tool: command not found',
    },
  ])
  expect(existsSync(join(String(workspaceFrame?.workspace.cwd), 'only-in-acme-app.txt'))).toBe(true)
}, 30_000)

test('a fork of a dev chat checks out the original working branch: on a new branch for another member, on the same branch with the open pull request card for its owner', async () => {
  const { launches, relay } = await stack.agentHost('fork host')
  if (!(await request(alice, 'GET', '/api/github-settings/configured')).body.configured)
    expect(await request(alice, 'POST', '/api/github-settings', appSettings)).toMatchObject({ status: 200 })
  const created = await request(alice, 'POST', '/api/dev-chats', {
    name: 'Fix totals',
    projectId: null,
    repository: 'acme/app',
    baseBranch: 'main',
  })
  const createdChatId = created.body?.chatId
  expect({ status: created.status, chatIdType: typeof createdChatId }).toEqual({ status: 201, chatIdType: 'string' })
  const source = chatId(createdChatId)
  const sourceRow = await stack.chatRow(source)
  expect(sourceRow).toMatchObject({ mode: 'dev', repository: 'acme/app', ownerUserId: alice })
  const sourceBranch = String(sourceRow?.gitBranch)
  expect(sourceBranch).toMatch(/^spyria\/fix-totals-[0-9a-f]{6}$/)
  fakeGitHub.commitToBranch('acme/app', {
    branch: sourceBranch,
    files: { 'totals.ts': 'export const total = 2\n' },
    message: 'Fix totals',
  })
  expect(
    await stack.mutate(aliceInAcme, 'conversation.inviteMember', {
      workspaceId: acme,
      chatId: source,
      memberId: bob,
      roleId: 'reader',
    }),
  ).toEqual(succeeded)
  const card = {
    type: 'pull_request',
    repository: 'acme/app',
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    title: 'Fix totals',
    state: 'open',
    headSha: 'a'.repeat(40),
    commits: 1,
    checks: {},
    review: null,
    comments: [],
  }
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, step, created_at)
    values (${acme}, ${source}, ${`message-${crypto.randomUUID()}`}, 1, 'step', ${alice}, 'pull_request',
      ${JSON.stringify(card)}::jsonb, now())`
  const forkAs = async (member: typeof aliceInAcme) => {
    const forked = chatId(crypto.randomUUID())
    const forking = { workspaceId: acme, id: `message-${crypto.randomUUID()}`, chatId: forked, sourceChatId: source }
    expect(await stack.mutate(member, 'conversation.forkChat', forking)).toEqual(succeeded)
    await stack.mutate(member, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: forked,
      runsOn: 'runtime',
    })
    const promptId = await stack.prompt(forked, 'stub:ls', member)
    await stack.answered(promptId)
    await waitFor(async () => (await stack.turnOf(forked)) === null, 15_000)
    const launch = (launches() as unknown as { repository: Record<string, unknown> }[]).at(-1)
    const cards = (await database.$client`select step from messages where chat_id = ${forked} and kind = 'step'`).map(
      ({ step }) => step,
    )
    const answer = (await stack.repliesTo(promptId)).map(({ body }) => body).join('')
    const sent = relay.prompts.at(-1)
    return { row: await stack.chatRow(forked), repository: launch?.repository, cards, answer, sent }
  }

  await addLlmKey(bob, 'Mistral')
  const bobs = await forkAs(bobInAcme)
  expect(bobs.row).toMatchObject({ mode: 'dev', repository: 'acme/app', baseBranch: 'main', ownerUserId: bob })
  expect(bobs.row?.gitBranch).toMatch(/^spyria\/fix-totals-fork-[0-9a-f]{6}$/)
  expect(bobs.repository).toMatchObject({
    base_branch: 'main',
    working_branch: bobs.row?.gitBranch,
    start_branch: sourceBranch,
  })
  expect(bobs.answer).toContain('totals.ts')
  expect(bobs.sent).toContain('Conversation so far, from the runtime chat Fix totals:')
  expect(bobs.cards).toEqual([])

  const alices = await forkAs(aliceInAcme)
  expect(alices.row).toMatchObject({ mode: 'dev', gitBranch: sourceBranch, ownerUserId: alice })
  expect(alices.repository).toMatchObject({ working_branch: sourceBranch, start_branch: sourceBranch })
  expect(alices.answer).toContain('totals.ts')
  expect(alices.sent).toContain('Conversation so far, from the runtime chat Fix totals:')
  expect(alices.cards).toEqual([card])
}, 60_000)
