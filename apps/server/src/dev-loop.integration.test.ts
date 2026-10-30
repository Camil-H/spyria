import { expect, setDefaultTimeout, test } from 'bun:test'

import { type ChatId, chatId, type DevLoopSettings, type DevLoopStepConfig } from '@spyria/kernel'
import { createSecretBox } from './auth/secret-box.ts'
import { createGitHubApi } from './github/github-api.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './testing/fake-github.ts'
import {
  acme,
  addLlmKey,
  alice,
  bob,
  failedWith,
  lee,
  rpcOf,
  runtimeTurn,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  testSecretsKey,
  textOf,
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
type Step = DevLoopStepConfig
const commandStep = (name: string, command: string, fixes = 3): Step => ({
  kind: 'command',
  name,
  command,
  timeoutMinutes: 5,
  fixes,
})
const settingsWith = (steps: Step[], setupCommand: string | null = null): DevLoopSettings => ({
  isOn: true,
  timeLimitMinutes: 240,
  costLimitMicros: null,
  pipelines: [{ repository: 'acme/app', setupCommand, steps }],
})
const setDevLoop = (userId: string, settings: DevLoopSettings | null) =>
  stack.mutate({ workspaceId: acme, userId }, 'workspace.setDevLoop', { workspaceId: acme, settings })
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
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${lee}, 'editor')`
  const [{ git_branch: branch } = {}] = await database.$client`select git_branch from chats where id = ${id}`
  return { id, branch: String(branch) }
}
const readyChat = async (id: ChatId) => {
  stack.setFakeLlmScript({ text: 'Ready.' })
  const promptId = await stack.prompt(id, 'Get ready')
  await stack.answered(promptId)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
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
const pushCheckRun = (headSha: string, name: string, conclusion: string, annotations: Annotation[] = []) =>
  fakeGitHub.checkRuns.push({ repository: 'acme/app', headSha, name, status: 'completed', conclusion, annotations })
const byTheLoop = { author_id: alice, actor: 'dev_loop', actor_kind: 'system', on_behalf_of: alice }

test('As a chat owner whose agent says its work is done, the repository pipeline runs in order: a failing command goes back to the agent, then the review, the pull request, failing CI back to the agent, and the hand-over once CI passes', async () => {
  expect(
    await setDevLoop(
      alice,
      settingsWith(
        [
          commandStep('Totals', 'grep -q fixed src/app.ts', 2),
          { kind: 'review', fixes: 1 },
          { kind: 'pull_request' },
          { kind: 'ci', checks: ['unit'], fixes: 1 },
        ],
        'echo set up > set-up.txt',
      ),
    ),
  ).toEqual(succeeded)
  const { launches } = await stack.agentHost('Dev loop host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id, branch } = await newDevChat()
  await readyChat(id)
  expect(launches().map((launch) => launch.repository?.setup_command)).toContain('echo set up > set-up.txt')
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
  const firstHead = String((await loopOf(id))?.step.pushedHead)
  expect(opened).toMatchObject({ title: 'Fix totals', body: 'The totals add up again' })
  expect((await loopOf(id))?.step).toMatchObject({
    position: 3,
    rounds: [1, 0, 0, 0],
    outcomes: ['passed', 'passed', 'passed', null],
    findings: [{ severity: 'nit', path: 'src/app.ts', title: 'Name the constant' }],
    pullRequestNumber: opened?.number,
  })

  pushCheckRun(firstHead, 'lint', 'failure')
  pushCheckRun(firstHead, 'unit', 'failure', [
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
  const secondHead = fakeGitHub.branchHeadOf('acme/app', branch)
  expect((await loopOf(id))?.step.pushedHead).toBe(secondHead)
  pushCheckRun(secondHead, 'unit', 'success')
  await loopStateIs(id, 'done')
  const ready = `Ready for your review on pull request #${opened?.number}: Totals, Code review and CI passed`
  expect((await loopOf(id))?.step).toMatchObject({ rounds: [1, 0, 0, 1], outcome: ready })
  expect((await loopOf(id))?.author_id).toBe(alice)
  expect(await loopPromptsOf(id)).toEqual([
    {
      body: "The dev loop ran the repository's checks and 1 failed. Fix the cause, commit, then call finish_work again.",
      phase: 'command',
      ...byTheLoop,
    },
    { body: 'The dev loop reviews your work before it is published.', phase: 'review_request', ...byTheLoop },
    {
      body: 'CI failed on the pull request (attempt 1 of 1). Fix the cause, commit, then call finish_work again.',
      phase: 'ci',
      ...byTheLoop,
    },
    { body: 'The dev loop reviews your work before it is published.', phase: 'review_request', ...byTheLoop },
  ])
  expect(fakeGitHub.pullRequests.filter(({ head }) => head === branch)).toHaveLength(1)
  expect(await noticesOf(id)).toContain(ready)
})

test('As a chat owner, a command that keeps failing ends with the agent saying what it would change, and a command that may not be fixed hands over at once', async () => {
  expect(await setDevLoop(alice, settingsWith([commandStep('Never', 'echo "still broken" && exit 1', 1)]))).toEqual(
    succeeded,
  )
  await stack.agentHost('Failing checks host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await readyChat(id)
  stack.setFakeLlmScript({
    steps: [committing('one', 'Try once'), finish],
    text: 'Done.',
    whenPrompted: [{ includes: 'Do not fix again', script: { text: 'The approach is wrong: totals need a ledger.' } }],
  })
  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'stopped')
  expect((await loopPromptsOf(id)).map(({ phase, body }) => ({ phase, body }))).toEqual([
    {
      phase: 'command',
      body: "The dev loop ran the repository's checks and 1 failed. Fix the cause, commit, then call finish_work again.",
    },
    {
      phase: 'command',
      body: 'Never still fails after 1 attempt to fix. Do not fix again: write for the owner what you think is wrong with the approach, what you would change, and what you need from them. Do not call finish_work.',
    },
  ])
  expect((await loopOf(id))?.step).toMatchObject({
    rounds: [2],
    outcomes: ['failed'],
    pullRequestNumber: null,
    outcome: 'Never still failed after 1 attempt to fix: over to you',
  })
  expect(await noticesOf(id)).toContain('Never still failed after 1 attempt to fix: over to you')

  expect(await setDevLoop(alice, settingsWith([commandStep('Strict', 'exit 1', 0)]))).toEqual(succeeded)
  const strict = await newDevChat()
  await readyChat(strict.id)
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(strict.id, 'Fix the totals')
  await loopStateIs(strict.id, 'stopped')
  expect((await loopOf(strict.id))?.step.outcome).toBe('Strict failed: over to you')
  expect(await loopPromptsOf(strict.id)).toEqual([])
})

test('As a member, writing in the chat stops the dev loop; another member’s prompt cannot start a loop; members who cannot connect GitHub cannot change the loop, and a pipeline must make sense', async () => {
  const slow = settingsWith([commandStep('Slow', 'sleep 3 && exit 1', 2)])
  expect(await setDevLoop(bob, slow)).toEqual(failedWith('Your workspace role does not allow this: Connect GitHub'))
  expect(await setDevLoop(alice, settingsWith([commandStep('Lint', 'bun run lint', 11)]))).toEqual(
    failedWith(
      'Each command step needs a name, a command and a timeout of 1 to 120 minutes; fixes go from 0 to 10; a pipeline has at most one review, pull request and CI step, with CI after the pull request; the time limit goes from 10 minutes to 24 hours',
    ),
  )
  expect(await setDevLoop(alice, slow)).toEqual(succeeded)
  const { host } = await stack.agentHost('Interrupted loop host', { routesModelCalls: true })
  await addLlmKey(lee, 'Anthropic')
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await readyChat(id)
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'running')
  const leesPrompt = await stack.prompt(id, 'Wait, use the ledger instead', { workspaceId: acme, userId: lee })
  expect((await loopOf(id))?.step).toMatchObject({ state: 'stopped', outcome: 'Stopped: Lee wrote in the chat' })
  await stack.answered(leesPrompt)
  await waitFor(async () => (await stack.turnOf(id)) === null, 20_000)
  expect((await loopOf(id))?.step.state).toBe('stopped')
  expect(await loopPromptsOf(id)).toEqual([])

  const guest = await runtimeTurn(host, lee)
  await database.$client`
    update chats set repository = 'acme/app', base_branch = 'main', git_branch = 'spyria/guest-loop' where id = ${guest.chatId}`
  const answer = await host.modelCall({
    path: '/mcp/github',
    headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' },
    body: rpcOf('tools/call', { name: 'finish_work', arguments: { title: 'Mine', body: '' } }),
  })
  const { result } = JSON.parse(answer.body)
  expect({ isError: result.isError, text: textOf(result) }).toEqual({
    isError: true,
    text: "Only Alice's prompts start the dev loop: tell the members here that the work is done",
  })
  expect(await loopOf(chatId(guest.chatId))).toBeUndefined()
})

test('As a chat owner, Stop stops the dev loop while it runs a command, and turning the loop off stops the loops still running', async () => {
  const slow = settingsWith([commandStep('Slow', 'sleep 3 && exit 1', 2)])
  expect(await setDevLoop(alice, slow)).toEqual(succeeded)
  await stack.agentHost('Stopped loop host', { routesModelCalls: true })
  await connectGitHub(alice)
  const stoppedChat = await newDevChat()
  await readyChat(stoppedChat.id)
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(stoppedChat.id, 'Fix the totals')
  await loopStateIs(stoppedChat.id, 'running')
  expect(
    await stack.mutate({ workspaceId: acme, userId: alice }, 'conversation.stopAgent', {
      workspaceId: acme,
      chatId: stoppedChat.id,
    }),
  ).toEqual(succeeded)
  expect((await loopOf(stoppedChat.id))?.step).toMatchObject({ state: 'stopped', outcome: 'Stopped by Alice' })

  const turnedOffChat = await newDevChat()
  await readyChat(turnedOffChat.id)
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(turnedOffChat.id, 'Fix the totals')
  await loopStateIs(turnedOffChat.id, 'running')
  expect(await setDevLoop(alice, { ...slow, isOn: false })).toEqual(succeeded)
  await loopStateIs(turnedOffChat.id, 'stopped')
  expect((await loopOf(turnedOffChat.id))?.step.outcome).toBe('Stopped: the dev loop was turned off in this workspace')
  expect(await loopPromptsOf(turnedOffChat.id)).toEqual([])
  expect(
    (
      await database.$client`select payload from workspace_events where type = 'dev_loop.changed' order by created_at`
    ).map(({ payload }) => payload.settings.isOn),
  ).toContain(false)
})
