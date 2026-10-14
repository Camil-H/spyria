import {
  agentReplyText,
  expect,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  sendMessage,
  sidebarOf,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'
import { fakeMcpUrl } from './stack-ports'

const researchChatId = 'chat-research'
const answer = 'The command printed hello.'
const commandScript = {
  steps: [{ think: 'I will run a command.' }, { command: 'echo hello from claude code' }],
  text: answer,
}
type GatewayLog = { provider: string; model: string; timestamp: string; metadata: Record<string, string> | null }

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', { name: /^Model chosen at first prompt$|^Claude Code · |· (auto|same as main)$/ })
const addKey = async (page: Page, provider: string) => {
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await llmSection.getByLabel('Provider').fill(provider)
  await llmSection.getByLabel('Secret').fill(`fake-key-${crypto.randomUUID()}`)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: provider })).toBeVisible()
}
const bobInResearch = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addKey(bobPage, 'Anthropic')
  await openChat(bobPage, 'Research')
  return bobPage
}
const gatewayLogsOf = async (workerStack: WorkerStack, since: Date) => {
  let logs: GatewayLog[] = []
  const query = `metadata_chat=${researchChatId}&metadata_database=${workerStack.databaseName}&start_time=${since.toISOString()}`
  await expect
    .poll(async () => {
      logs = (await workerStack.gateway<{ logs: GatewayLog[] | null }>(`/api/logs?${query}&limit=100`)).logs ?? []
      return logs.length
    })
    .toBeGreaterThanOrEqual(1)
  return logs.toSorted((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp))
}

test.describe('real Agent Server', { tag: '@docker' }, () => {
  test.use({ agentServer: 'real' })
  test.describe.configure({ mode: 'default' })
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('1. a member whose only key is Anthropic gets Claude Code: the chip, a terminal step, the answer, and Usage on the prompter', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, commandScript)
    await sendMessage(bobPage, 'Say hello from the terminal')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible()
    await expect(chipOf(bobPage)).toHaveText('Claude Code · Opus 5.5')
    await messageItemsOf(bobPage)
      .getByRole('button', { name: /^Worked for .+ · 2 steps$/ })
      .click()
    await expect(mainOf(bobPage)).toContainText('echo hello from claude code')
    await messageItemsOf(bobPage)
      .getByRole('button', { name: /^Thought for / })
      .click()
    await expect(mainOf(bobPage)).toContainText('I will run a command.')
    await expect
      .poll(
        async () =>
          (
            await workerStack.database.$client<{ prompters: string[] }[]>`
              select array_agg(distinct prompter_id) as prompters from model_calls where chat_id = ${researchChatId}`
          )[0]?.prompters,
      )
      .toEqual(['member-bob'])
    await bobPage.context().close()
  })

  test('2. a member with an Anthropic and another key gets the native agent and routing as today', async ({
    page,
    workerStack,
  }) => {
    await addKey(page, 'Anthropic')
    await openChat(page, 'Research')
    await sendMessage(page, 'Route me as usual')
    await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toBeVisible()
    await expect(chipOf(page)).toHaveText(/^[^·]+ \((low|medium|high)\) · auto$/)
    const [chat] = await workerStack.database.$client<{ harness: string | null }[]>`
      select harness from chats where id = ${researchChatId}`
    expect(chat?.harness).toBeNull()
    const decisions = await workerStack.database.$client`
      select role from routing_decisions where chat_id = ${researchChatId}`
    expect(decisions.map((decision) => decision.role)).toEqual(['session'])
  })

  test('3. an invitee without an Anthropic key prompting a Claude Code session gets the notice and no gateway call', async ({
    page,
    browser,
    workerStack,
    agentScript,
  }) => {
    const startedAt = new Date()
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { text: answer })
    await sendMessage(bobPage, 'Start the Claude Code session')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible()
    await openChat(page, 'Research')
    await sendMessage(page, 'Alice joins without an Anthropic key')
    await expect(mainOf(page)).toContainText('This session runs Claude Code on Anthropic keys')
    const prompters = (await gatewayLogsOf(workerStack, startedAt)).map((log) => log.metadata?.prompter)
    expect(new Set(prompters)).toEqual(new Set(['member-bob']))
    await bobPage.context().close()
  })

  test('4. a scripted Task subagent shows as one step group with its inner steps', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, {
      steps: [{ task: 'List the project' }],
      text: answer,
      subagents: {
        task: {
          steps: [{ command: 'echo inside the subagent' }, { edit: { path: 'notes.md', create: 'one\ntwo\n' } }],
          text: 'The subagent listed it.',
        },
      },
    })
    await sendMessage(bobPage, 'Delegate the listing to a subagent')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible()
    await mainOf(bobPage)
      .getByRole('button', { name: /^Subagent · 2 steps · / })
      .click()
    const subagentSteps = mainOf(bobPage).getByRole('group', { name: 'Steps of the subagent' })
    await expect(subagentSteps).toContainText('echo inside the subagent')
    await expect(subagentSteps).toContainText('Created notes.md +2 −0')
    await expect(mainOf(bobPage)).toContainText('The subagent listed it.')
    await bobPage.context().close()
  })

  test('5. a scripted personal tool call from Claude Code runs as the owner and shows as a step', async ({
    page,
    browser,
    workerStack,
    agentScript,
  }) => {
    const account = `alice-acme-${crypto.randomUUID().slice(0, 8)}`
    const connections = mainOf(page).getByRole('region', { name: 'Connections' })
    await page.context().addCookies([{ name: 'fake_mcp_user', value: account, url: fakeMcpUrl }])
    await page.goto('/w/workspace-acme/profile')
    await connections.getByRole('tab', { name: 'My connections' }).click()
    const popup = page.waitForEvent('popup')
    await connections.getByRole('button', { name: 'Connect fake', exact: true }).click()
    await (await popup).waitForEvent('close')
    await expect(connections.getByRole('listitem').filter({ hasText: 'fake' })).toContainText('Connected')
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ tool: 'fake-whoami' }], text: answer })
    await sendMessage(bobPage, 'Who am I on fake')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible()
    const events = await workerStack.database
      .$client`select payload from events where chat_id = ${researchChatId} and type = 'agent.event' order by seq`
    await messageItemsOf(bobPage).getByRole('button', { name: 'Used whoami (fake)' }).click()
    await expect(mainOf(bobPage)).toContainText(`you are ${account}`)
    await bobPage.context().close()
  })

  test('6. stopping mid-command marks the turn stopped, and the next prompt is answered once', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ command: 'sleep 60' }], text: 'Never shown.' })
    await sendMessage(bobPage, 'Run the long command')
    await expect(messageItemsOf(bobPage).getByRole('img', { name: 'Running' })).toBeVisible()
    await mainOf(bobPage).getByRole('button', { name: 'Stop' }).click()
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Stopped by Bob' })).toHaveCount(1)
    await agentScript(researchChatId, { text: 'Back after the stop.' })
    await sendMessage(bobPage, 'Answer after the stop')
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Back after the stop.' })).toHaveCount(1)
    await expect(bobPage.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
    const events = await workerStack.database
      .$client`select payload from events where chat_id = ${researchChatId} and type = 'agent.event' order by seq`
    await expect(mainOf(bobPage)).not.toContainText('Never shown.')
    await expect(messageItemsOf(bobPage).filter({ hasText: agentReplyText })).toHaveCount(0)
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Stopped by Bob' })).toHaveCount(1)
    const sessionIds = await workerStack.database.$client`
      select distinct payload->'event'->'value'->>'acp_session_id' as id from events
      where chat_id = ${researchChatId} and payload->'event'->>'key' = 'agent_state'`
    expect(sessionIds).toHaveLength(1)
    await bobPage.context().close()
  })

  test('7. a scripted 529 shows HQ’s notice on the turn', async ({ browser, workerStack, agentScript }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ fail: 'Overloaded' }] })
    await sendMessage(bobPage, 'Fail with an overloaded provider')
    await expect(mainOf(bobPage)).toContainText('The provider is unavailable, try again shortly')
    await bobPage.context().close()
  })

  test('8. the gateway log of the first call shows anthropic/claude-opus-5-5', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const startedAt = new Date()
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { text: answer })
    await sendMessage(bobPage, 'Which model runs this session')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible()
    const [first] = await gatewayLogsOf(workerStack, startedAt)
    expect(`${first?.provider}/${first?.model}`).toBe('anthropic/claude-opus-5-5')
    await bobPage.context().close()
  })
  test('9. a Claude Code chat whose conversation was lost without a Stop answers its next prompt promptly, without resuming', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    const lostSessionId = crypto.randomUUID()
    const lostState = {
      replyToId: null,
      event: {
        id: crypto.randomUUID(),
        kind: 'ConversationStateUpdateEvent',
        key: 'agent_state',
        value: { acp_session_id: lostSessionId },
        timestamp: '2026-01-01T00:00:00',
      },
    }
    await workerStack.database.$client`
      update chats set harness = 'claude-code', model = 'anthropic/claude-opus-5-5' where id = ${researchChatId}`
    await workerStack.database.$client`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      select 'workspace-acme', ${researchChatId}, ${lostState.event.id}, coalesce(max(seq), 0) + 1, 'agent.event', null, ${JSON.stringify(lostState)}::jsonb, now()
      from events where workspace_id = 'workspace-acme' and chat_id = ${researchChatId}`
    await agentScript(researchChatId, { text: answer })
    await sendMessage(bobPage, 'Answer in a fresh session')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toHaveCount(1, { timeout: 30_000 })
    const sessionIds = await workerStack.database.$client<{ id: string }[]>`
      select distinct payload->'event'->'value'->>'acp_session_id' as id from events
      where chat_id = ${researchChatId} and payload->'event'->>'key' = 'agent_state'`
    expect(sessionIds.map(({ id }) => id)).toContain(lostSessionId)
    expect(sessionIds).toHaveLength(2)
    await bobPage.context().close()
  })
})
