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
const settingsWith = (steps: Step[], isOn = true): DevLoopSettings => ({
  rules: [{ repository: 'acme/app', isOn, timeLimitMinutes: 240, costLimitMicros: null, steps }],
})
const setSetupCommands = (userId: string, commands: { repository: string | null; command: string }[]) =>
  stack.mutate({ workspaceId: acme, userId }, 'workspace.setSetupCommands', { workspaceId: acme, commands })
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
      settingsWith([
        commandStep('Totals', 'grep -q fixed src/app.ts', 2),
        { kind: 'review', fixes: 1 },
        { kind: 'pull_request' },
        { kind: 'ci', fixes: 1 },
      ]),
    ),
  ).toEqual(succeeded)
  expect(await setSetupCommands(bob, [{ repository: 'acme/app', command: 'echo set up > set-up.txt' }])).toEqual(
    failedWith('Your workspace role does not allow this: Manage runtime hosts and local sessions'),
  )
  expect(
    await setSetupCommands(alice, [
      { repository: null, command: 'echo default > set-up.txt' },
      { repository: 'acme/app', command: 'echo set up > set-up.txt' },
    ]),
  ).toEqual(succeeded)
  const { launches } = await stack.agentHost('Quality gates host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id, branch } = await newDevChat()
  await readyChat(id)
  expect(launches().map((launch) => launch.repository?.setup_command)).toContain('echo set up > set-up.txt')
  stack.setFakeLlmScript({
    steps: [committing('export const total = 3', 'Change the totals'), finish],
    text: 'Done.',
    whenPrompted: [
      {
        includes: "Quality gates ran the repository's checks",
        script: { steps: [committing('// fixed', 'Fix the totals'), finish], text: 'Fixed.' },
      },
      {
        includes: 'Quality gates review your work',
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
    findings: [{ id: 'F1', severity: 'nit', path: 'src/app.ts', title: 'Name the constant' }],
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
  expect(ciPrompt).toContain('- lint: failure')

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
      body: "Quality gates ran the repository's checks and 1 failed. Fix the cause, commit, then call finish_work again.",
      phase: 'command',
      ...byTheLoop,
    },
    { body: 'Quality gates review your work before it is published.', phase: 'review_request', ...byTheLoop },
    {
      body: 'CI failed on the pull request (attempt 1 of 1). Fix the cause, commit, then call finish_work again.',
      phase: 'ci',
      ...byTheLoop,
    },
    { body: 'Quality gates review your work before it is published.', phase: 'review_request', ...byTheLoop },
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
      body: "Quality gates ran the repository's checks and 1 failed. Fix the cause, commit, then call finish_work again.",
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

test('As a member, writing in the chat stops the quality gates; another member’s prompt cannot start a loop; members who cannot connect GitHub cannot change the loop, and a pipeline must make sense', async () => {
  const slow = settingsWith([commandStep('Slow', 'sleep 3 && exit 1', 2)])
  expect(await setDevLoop(bob, slow)).toEqual(failedWith('Your workspace role does not allow this: Connect GitHub'))
  expect(await setDevLoop(alice, settingsWith([commandStep('Lint', 'bun run lint', 11)]))).toEqual(
    failedWith(
      'Each command gate needs a name of its own, a command and a timeout of 1 to 120 minutes; fixes go from 0 to 10; a repository has at most 20 gates, one code review, one pull request and one CI gate, and only CI may follow the pull request; the time limit goes from 10 minutes to 24 hours and a cost limit is above 0',
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
    text: "Only Alice's prompts start quality gates: tell the members here that the work is done",
  })
  expect(await loopOf(chatId(guest.chatId))).toBeUndefined()
})

test('As a chat owner, Stop stops the quality gates while it runs a command, and turning the loop off stops the loops still running', async () => {
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
  expect(await setDevLoop(alice, settingsWith([commandStep('Slow', 'sleep 3 && exit 1', 2)], false))).toEqual(succeeded)
  await loopStateIs(turnedOffChat.id, 'stopped')
  expect((await loopOf(turnedOffChat.id))?.step.outcome).toBe(
    'Stopped: quality gates were turned off for this repository',
  )
  expect(await loopPromptsOf(turnedOffChat.id)).toEqual([])
  expect(
    (
      await database.$client`select payload from workspace_events where type = 'dev_loop.changed' order by created_at`
    ).map(({ payload }) => payload.settings.rules[0].isOn),
  ).toContain(false)
})

test('As a chat owner whose agent does not fix what the review found, the next review checks it again and sends it back, then hands over after the review’s fixes', async () => {
  expect(await setDevLoop(alice, settingsWith([{ kind: 'review', fixes: 2 }]))).toEqual(succeeded)
  await stack.agentHost('Unfixed review host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await readyChat(id)
  const reportReview = (report: Record<string, unknown>) => ({
    steps: [{ tool: 'report_review', arguments: report }],
    text: 'Reviewed.',
  })
  stack.setFakeLlmScript({
    steps: [committing('export const total = 3', 'Change the totals'), finish],
    text: 'Done.',
    whenPrompted: [
      { includes: 'These findings sent the work back', script: reportReview({ findings: [], unresolved: ['F1'] }) },
      {
        includes: 'Quality gates review your work',
        script: reportReview({
          findings: [{ severity: 'important', path: 'src/app.ts', line: 1, title: 'Total is hard-coded' }],
        }),
      },
      { includes: 'The review found', script: { steps: [finish], text: 'Fixed.' } },
      { includes: 'Do not fix again', script: { text: 'The totals need a ledger.' } },
    ],
  })

  await stack.prompt(id, 'Fix the totals')
  await loopStateIs(id, 'stopped')
  const handOver = 'Code review still failed after 2 attempts to fix: over to you'
  expect((await loopOf(id))?.step).toMatchObject({
    rounds: [3],
    outcomes: ['failed'],
    findings: [{ id: 'F1', severity: 'important', title: 'Total is hard-coded', isResolved: false }],
    outcome: handOver,
  })
  expect((await loopPromptsOf(id)).map(({ phase, body }) => ({ phase, body }))).toEqual([
    { phase: 'review_request', body: 'Quality gates review your work before it is published.' },
    {
      phase: 'review',
      body: 'The review found 1 important defect in this diff (attempt 1 of 2). Fix every instance of each, not only the line shown, commit, then call finish_work again.',
    },
    { phase: 'review_request', body: 'Quality gates review your work before it is published.' },
    {
      phase: 'review',
      body: 'The review found 1 important defect in this diff (attempt 2 of 2). Fix every instance of each, not only the line shown, commit, then call finish_work again.',
    },
    { phase: 'review_request', body: 'Quality gates review your work before it is published.' },
    {
      phase: 'review',
      body: 'Code review still fails after 2 attempts to fix. Do not fix again: write for the owner what you think is wrong with the approach, what you would change, and what you need from them. Do not call finish_work.',
    },
  ])
  const prompts = (
    await database.$client`select body from messages where chat_id = ${id} and step->>'type' = 'dev_loop_prompt' order by seq`
  ).map(({ body }) => String(body))
  expect(prompts[2]).toContain('These findings sent the work back.')
  expect(prompts[2]).toContain('- [F1] [important] src/app.ts:1: Total is hard-coded')
  expect(prompts[3]).toContain(
    'Found again after your last fix:\n\n- [F1] [important] src/app.ts:1: Total is hard-coded',
  )
  expect(await noticesOf(id)).toContain(handOver)
})

test('As a chat owner, the quality gates card shows each command of a group pass or fail as soon as it finishes while the next one runs, and the verdict waits for the last command', async () => {
  const commands = [commandStep('Quick', 'true'), commandStep('Broken', 'exit 1', 0), commandStep('Slow', 'sleep 3')]
  expect(await setDevLoop(alice, settingsWith(commands))).toEqual(succeeded)
  await stack.agentHost('Command progress host', { routesModelCalls: true })
  await connectGitHub(alice)
  const { id } = await newDevChat()
  await readyChat(id)
  stack.setFakeLlmScript({ steps: [committing('one', 'Try once'), finish], text: 'Done.' })
  await stack.prompt(id, 'Fix the totals')

  await waitFor(async () => {
    const step = (await loopOf(id))?.step
    return step?.state === 'running' && (step.outcomes as unknown[])[1] !== null
  }, 60_000)
  const midRun = (await loopOf(id))?.step
  expect(midRun).toMatchObject({ state: 'running', position: 0, outcomes: ['passed', 'failed', null] })

  await loopStateIs(id, 'stopped')
  expect((await loopOf(id))?.step).toMatchObject({
    outcomes: ['passed', 'failed', 'passed'],
    outcome: 'Broken failed: over to you',
  })
})
