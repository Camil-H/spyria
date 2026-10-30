import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChatId, chatId, type DevLoopSettings, defaultDevLoopSettings } from '@spyria/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { createGitHubApi } from './github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './testing/fake-github.ts'
import {
  acme,
  alice,
  bob,
  failedWith,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  testSecretsKey,
  waitFor,
} from './testing/testing.ts'

setDefaultTimeout(120_000)
const fakeGitHub = startFakeGitHub()
const secretBox = createSecretBox(testSecretsKey)
const stack = await startAgentStack({ routing: true, github: { api: createGitHubApi(fakeGitHub.urls), secretBox } })
const { app, database } = stack
const finish = { tool: 'finish_work', arguments: { title: 'Fix totals', body: 'The totals add up again' } }
const committing = (line: string, message: string) => ({
  command: `echo '${line}' >> src/app.ts && git -c user.name=Pi -c user.email=pi@example.com commit -qam '${message}'`,
})

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

expect(
  await request(alice, 'POST', '/api/github-settings', {
    appId: fakeGitHubAppId,
    clientId: fakeGitHubClientId,
    clientSecret: fakeGitHubClientSecret,
    privateKey: fakeGitHub.appPrivateKey,
    webhookSecret: 'whsec-dev-loop-0123',
  }),
).toMatchObject({ status: 200 })

const connectGitHub = async (userId: string) => {
  const started = await request(userId, 'POST', '/api/github/connection/connect')
  const authorized = await fetch(started.body.authorizeUrl, { redirect: 'manual' })
  const callback = new URL(authorized.headers.get('location') ?? '')
  expect((await app.request(`${callback.pathname}${callback.search}`)).status).toBe(200)
}
const setDevLoop = (userId: string, settings: DevLoopSettings | null) =>
  stack.mutate({ workspaceId: acme, userId }, 'conversation.setDevLoop', { workspaceId: acme, settings })
const newDevChat = async () => {
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
  await database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${bob}, 'editor')`
  const [{ git_branch: branch } = {}] = await database.$client`select git_branch from chats where id = ${id}`
  return { id, branch: String(branch) }
}
const workspaceWithChecks = async (id: ChatId, config: object) => {
  stack.setFakeLlmScript({ text: 'Ready.' })
  const promptId = await stack.prompt(id, 'Get ready')
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  const frames = (await stack.subscribedFrames(id)).map((frame) => JSON.parse(frame))
  const workspace = String(frames.find((frame) => frame.workspace)?.workspace.cwd)
  mkdirSync(join(workspace, '.spyria'), { recursive: true })
  writeFileSync(join(workspace, '.spyria/dev-loop.json'), JSON.stringify(config))
  Bun.spawnSync(['git', '-c', 'user.name=Pi', '-c', 'user.email=pi@example.com', 'add', '-A'], { cwd: workspace })
  Bun.spawnSync(['git', '-c', 'user.name=Pi', '-c', 'user.email=pi@example.com', 'commit', '-qm', 'Add checks'], {
    cwd: workspace,
  })
  return workspace
}
const loopOf = async (id: ChatId) =>
  (
    await database.$client`
      select author_id, step from messages where chat_id = ${id} and step->>'type' = 'dev_loop' order by seq desc limit 1`
  )[0] as { author_id: string; step: Record<string, unknown> } | undefined
const loopStateIs = (id: ChatId, state: string) => waitFor(async () => (await loopOf(id))?.step.state === state, 60_000)
const loopPromptsOf = async (id: ChatId) =>
  (
    await database.$client`
      select m.body, m.author_id, m.step->>'phase' as phase, e.actor, e.actor_kind, e.on_behalf_of
      from messages m join events e on e.workspace_id = m.workspace_id and e.id = m.id
      where m.chat_id = ${id} and m.step->>'type' = 'dev_loop_prompt' order by m.seq`
  ).map((row) => ({
    body: String(row.body).split('\n')[0],
    author_id: row.author_id,
    phase: row.phase,
    actor: row.actor,
    actor_kind: row.actor_kind,
    on_behalf_of: row.on_behalf_of,
  }))
const noticesOf = async (id: ChatId) =>
  (await database.$client`select body from messages where chat_id = ${id} and kind = 'notice' order by seq`).map(
    ({ body }) => String(body),
  )
type Annotation = { path: string; line: number; title: string; message: string }
const pushCheckRun = (branch: string, name: string, conclusion: string, annotations: Annotation[] = []) =>
  fakeGitHub.checkRuns.push({
    repository: 'acme/app',
    headSha: fakeGitHub.branchHeadOf('acme/app', branch),
    name,
    status: 'completed',
    conclusion,
    annotations,
  })

test('As a chat owner whose agent says its work is done, the dev loop runs the checks and sends the failure back, has the diff reviewed, opens the pull request, sends failing CI back, and hands over once CI passes', async () => {
  expect(await setDevLoop(alice, { ...defaultDevLoopSettings, checkRounds: 2, reviewRounds: 1, ciRounds: 1 })).toEqual(
    succeeded,
  )
  await stack.agentHost('Dev loop host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id, branch } = await newDevChat()
  await workspaceWithChecks(id, { checks: { Totals: 'grep -q fixed src/app.ts' }, ci: ['unit'] })
  stack.setFakeLlmScript({
    steps: [committing('export const total = 3', 'Change the totals'), finish],
    text: 'Done.',
    whenPrompted: [
      {
        includes: "The dev loop ran the repository's checks",
        script: { steps: [committing('// fixed', 'Fix the totals'), finish], text: 'Fixed.' },
      },
      {
        includes: 'The dev loop reviews your work',
        script: {
          steps: [
            {
              tool: 'report_review',
              arguments: { findings: [{ severity: 'nit', path: 'src/app.ts', title: 'Name the constant' }] },
            },
          ],
          text: 'Reviewed.',
        },
      },
      {
        includes: 'CI failed on the pull request',
        script: { steps: [committing('// fixed for CI', 'Fix CI'), finish], text: 'Fixed CI.' },
      },
    ],
  })

  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'waiting_for_ci')
  const opened = fakeGitHub.pullRequests.at(-1)
  const firstHead = (await loopOf(id))?.step.pushedHead
  expect(opened).toMatchObject({ title: 'Fix totals', body: 'The totals add up again' })
  expect((await loopOf(id))?.step).toMatchObject({
    rounds: { checks: 1, review: 0, ci: 0 },
    checks: [{ name: 'Totals', passed: true }],
    ci: ['unit'],
    findings: [{ severity: 'nit', path: 'src/app.ts', title: 'Name the constant' }],
    pullRequestNumber: opened?.number,
  })

  pushCheckRun(branch, 'lint', 'failure')
  pushCheckRun(branch, 'unit', 'failure', [
    { path: 'src/app.test.ts', line: 3, title: 'totals add up', message: 'Expected: 3\nReceived: 2' },
  ])
  await waitFor(async () => (await loopPromptsOf(id)).some(({ phase }) => phase === 'ci'), 60_000)
  const ciPrompt = (
    await database.$client`select body from messages where chat_id = ${id} and step->>'phase' = 'ci'`
  )[0]?.body
  expect(ciPrompt).toContain('CI failed on the pull request (attempt 1 of 1)')
  expect(ciPrompt).toContain('src/app.test.ts:3 failure: totals add up')
  expect(ciPrompt).not.toContain('- lint:')

  await waitFor(async () => {
    const step = (await loopOf(id))?.step
    return step?.state === 'waiting_for_ci' && step.pushedHead !== firstHead
  }, 60_000)
  expect((await loopOf(id))?.step.pushedHead).toBe(fakeGitHub.branchHeadOf('acme/app', branch))
  pushCheckRun(branch, 'unit', 'success')
  await loopStateIs(id, 'done')
  expect((await loopOf(id))?.step).toMatchObject({
    rounds: { checks: 1, review: 0, ci: 1 },
    outcome: `Ready for your review on pull request #${opened?.number}: checks, review and CI passed`,
  })
  expect((await loopOf(id))?.author_id).toBe(alice)
  expect(await loopPromptsOf(id)).toEqual([
    {
      body: "The dev loop ran the repository's checks and 1 failed (attempt 1 of 2). Fix the cause, commit, then call finish_work again.",
      author_id: alice,
      phase: 'checks',
      actor: 'dev_loop',
      actor_kind: 'system',
      on_behalf_of: alice,
    },
    {
      body: 'The dev loop reviews your work before it is published.',
      author_id: alice,
      phase: 'review_request',
      actor: 'dev_loop',
      actor_kind: 'system',
      on_behalf_of: alice,
    },
    {
      body: 'CI failed on the pull request (attempt 1 of 1). Fix the cause, commit, then call finish_work again.',
      author_id: alice,
      phase: 'ci',
      actor: 'dev_loop',
      actor_kind: 'system',
      on_behalf_of: alice,
    },
    {
      body: 'The dev loop reviews your work before it is published.',
      author_id: alice,
      phase: 'review_request',
      actor: 'dev_loop',
      actor_kind: 'system',
      on_behalf_of: alice,
    },
  ])
  expect(fakeGitHub.pullRequests.filter(({ head }) => head === branch)).toHaveLength(1)
  expect(await noticesOf(id)).toContain(
    `Ready for your review on pull request #${opened?.number}: checks, review and CI passed`,
  )
})

test('As a chat owner, checks that keep failing end with the agent saying what it would change, then the loop hands over to me', async () => {
  expect(await setDevLoop(alice, { ...defaultDevLoopSettings, checkRounds: 1 })).toEqual(succeeded)
  await stack.agentHost('Failing checks host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await workspaceWithChecks(id, { checks: { Never: 'echo "still broken" && exit 1' } })
  stack.setFakeLlmScript({
    steps: [committing('one', 'Try once'), finish],
    text: 'Done.',
    whenPrompted: [{ includes: 'Do not fix again', script: { text: 'The approach is wrong: totals need a ledger.' } }],
  })
  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'stopped')
  expect((await loopPromptsOf(id)).map(({ phase, body }) => ({ phase, body }))).toEqual([
    {
      phase: 'checks',
      body: "The dev loop ran the repository's checks and 1 failed (attempt 1 of 1). Fix the cause, commit, then call finish_work again.",
    },
    {
      phase: 'checks',
      body: 'The checks still fail after 1 attempt to fix. Do not fix again: write for the owner what you think is wrong with the approach, what you would change, and what you need from them. Do not call finish_work.',
    },
  ])
  expect((await loopOf(id))?.step).toMatchObject({
    rounds: { checks: 2 },
    pullRequestNumber: null,
    outcome: 'The checks still failed after 1 attempt to fix: over to you',
  })
  expect(await noticesOf(id)).toContain('The checks still failed after 1 attempt to fix: over to you')
})

test('As a member, writing in the chat stops the dev loop; another member’s prompt cannot start a loop; members who cannot connect GitHub cannot change the loop', async () => {
  expect(await setDevLoop(bob, defaultDevLoopSettings)).toEqual(
    failedWith('Your workspace role does not allow this: Connect GitHub'),
  )
  expect(await setDevLoop(alice, { ...defaultDevLoopSettings, checkRounds: 0 } as DevLoopSettings)).toEqual(
    failedWith('Rounds, the time limit and the cost limit must be whole numbers within their ranges'),
  )
  expect(await setDevLoop(alice, { ...defaultDevLoopSettings, checkRounds: 2 })).toEqual(succeeded)
  await stack.agentHost('Interrupted loop host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await workspaceWithChecks(id, { checks: { Slow: 'sleep 3 && exit 1' } })
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'checking')
  const bobsPrompt = await stack.prompt(id, 'Wait, use the ledger instead', { workspaceId: acme, userId: bob })
  expect((await loopOf(id))?.step).toMatchObject({ state: 'stopped', outcome: 'Stopped: Bob wrote in the chat' })
  await stack.answered(bobsPrompt)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  const refusals = (
    await database.$client`
      select tool, status from tool_calls where chat_id = ${id} and prompter_id = ${bob} order by called_at`
  ).map(({ tool, status }) => ({ tool, status }))
  expect(refusals).toEqual([{ tool: 'finish_work', status: 'refused' }])
  expect((await loopOf(id))?.step.state).toBe('stopped')
  expect(await loopPromptsOf(id)).toEqual([])
})

test('As a chat owner, Stop stops the dev loop while it runs the checks, and turning the loop off stops the loops still running', async () => {
  expect(await setDevLoop(alice, defaultDevLoopSettings)).toEqual(succeeded)
  await stack.agentHost('Stopped loop host', { routesModelCalls: true })
  await connectGitHub(alice)
  const stoppedChat = await newDevChat()
  await workspaceWithChecks(stoppedChat.id, { checks: { Slow: 'sleep 3 && exit 1' } })
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(stoppedChat.id, 'Fix the totals')
  await loopStateIs(stoppedChat.id, 'checking')
  expect(
    await stack.mutate({ workspaceId: acme, userId: alice }, 'conversation.stopAgent', {
      workspaceId: acme,
      chatId: stoppedChat.id,
    }),
  ).toEqual(succeeded)
  expect((await loopOf(stoppedChat.id))?.step).toMatchObject({ state: 'stopped', outcome: 'Stopped by Alice' })

  const turnedOffChat = await newDevChat()
  await workspaceWithChecks(turnedOffChat.id, { checks: { Slow: 'sleep 3 && exit 1' } })
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(turnedOffChat.id, 'Fix the totals')
  await loopStateIs(turnedOffChat.id, 'checking')
  expect(await setDevLoop(alice, null)).toEqual(succeeded)
  await loopStateIs(turnedOffChat.id, 'stopped')
  expect((await loopOf(turnedOffChat.id))?.step.outcome).toBe('Stopped: the dev loop was turned off in this workspace')
  expect(await loopPromptsOf(turnedOffChat.id)).toEqual([])
  expect(
    (
      await database.$client`select payload from workspace_events where type = 'dev_loop.changed' order by created_at`
    ).map(({ payload }) => payload.settings),
  ).toContainEqual(null)
})
