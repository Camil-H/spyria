import { afterAll, expect } from 'bun:test'
import { type ChatId, chatId } from '@spyria/kernel'
import { createSecretBox } from '../auth/secret-box.ts'
import { createGitHubApi } from '../github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './fake-github.ts'
import { acme, alice, sessionTokenOf, startAgentStack, testSecretsKeyring, waitFor } from './testing.ts'

export const gitIn = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Pi Agent', '-c', 'user.email=agent@example.com', ...command], {
    cwd,
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

type DevChatOptions = {
  repository?: string
  baseBranch?: string
  participants?: { memberId: string; roleId: string }[]
}

export const startGitHubStack = async (
  options: Omit<NonNullable<Parameters<typeof startAgentStack>[0]>, 'github'> = {},
) => {
  const fakeGitHub = startFakeGitHub()
  const secretBox = createSecretBox(testSecretsKeyring)
  const stack = await startAgentStack({ ...options, github: { api: createGitHubApi(fakeGitHub.urls), secretBox } })
  afterAll(() => fakeGitHub.stop())
  const { app, database } = stack

  const requestWithText = async (userId: string, method: string, path: string, body?: object) => {
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
  const request = async (userId: string, method: string, path: string, body?: object) => {
    const { status, body: answer } = await requestWithText(userId, method, path, body)
    return { status, body: answer }
  }
  const appSettingsWith = (webhookSecret: string) => ({
    appId: fakeGitHubAppId,
    clientId: fakeGitHubClientId,
    clientSecret: fakeGitHubClientSecret,
    privateKey: fakeGitHub.appPrivateKey,
    webhookSecret,
  })
  const configureGitHubApp = async (webhookSecret: string) =>
    expect(await request(alice, 'POST', '/api/github-settings', appSettingsWith(webhookSecret))).toMatchObject({
      status: 200,
    })
  const ensureGitHubApp = async (webhookSecret: string) => {
    if (!(await request(alice, 'GET', '/api/github-settings/configured')).body.configured)
      await configureGitHubApp(webhookSecret)
  }
  const githubCallbackOf = async (userId: string) => {
    const started = await request(userId, 'POST', '/api/github/connection/connect')
    const authorized = await fetch(new URL(started.body.authorizeUrl), { redirect: 'manual' })
    const callback = new URL(authorized.headers.get('location') ?? '')
    return `${callback.pathname}${callback.search}`
  }
  const connectGitHub = async (userId: string) => {
    expect((await app.request(await githubCallbackOf(userId))).status).toBe(200)
    const [row] = await database.$client`
      select encrypted_access_token from github_connections where workspace_id = ${acme} and user_id = ${userId}`
    return secretBox.open(String(row?.encrypted_access_token))
  }
  const disconnectGitHub = async (userId: string) =>
    expect(await request(userId, 'POST', '/api/github/connection/disconnect')).toMatchObject({ status: 200 })
  const newDevChat = async ({
    repository = 'acme/app',
    baseBranch = 'main',
    participants = [],
  }: DevChatOptions = {}) => {
    const created = await request(alice, 'POST', '/api/dev-chats', {
      name: 'Fix totals',
      projectId: null,
      repository,
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
  const turnEnded = async (id: ChatId, text: string) => {
    const promptId = await stack.prompt(id, text)
    await stack.answered(promptId)
    await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
    return promptId
  }
  const promptAndWait = async (id: ChatId, text: string) =>
    stack.repliesTo(await turnEnded(id, text), ['kind', 'body', 'step'])
  const workspaceOf = async (id: ChatId) => {
    const frames = (await stack.subscribedFrames(id)).map((frame) => JSON.parse(frame))
    return String(frames.find((frame) => frame.workspace)?.workspace.cwd)
  }
  const snapshotOf = async (id: ChatId) =>
    (await database.$client`select workspace_snapshot from runtimes where chat_id = ${id}`)[0]?.workspace_snapshot
  const runtimeWorkspaceOf = async (id: ChatId) => {
    const promptId = await turnEnded(id, 'stub:ls')
    await waitFor(async () => (await snapshotOf(id)) != null, 20_000)
    return { promptId, workspace: await workspaceOf(id) }
  }

  return {
    stack,
    fakeGitHub,
    secretBox,
    request,
    requestWithText,
    appSettingsWith,
    configureGitHubApp,
    ensureGitHubApp,
    githubCallbackOf,
    connectGitHub,
    disconnectGitHub,
    newDevChat,
    turnEnded,
    promptAndWait,
    workspaceOf,
    snapshotOf,
    runtimeWorkspaceOf,
  }
}
