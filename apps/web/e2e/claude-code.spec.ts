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

const agentReply = { timeout: 90_000 }
const metered = { timeout: 30_000 }
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
    }, metered)
    .toBeGreaterThanOrEqual(1)
  return logs.toSorted((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp))
}

test.describe('real Agent Server', () => {
  test.use({ agentServer: 'real' })
  test.describe.configure({ mode: 'default', timeout: 180_000 })
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
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
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
        metered,
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
    await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toBeVisible(agentReply)
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
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
    await openChat(page, 'Research')
    await sendMessage(page, 'Alice joins without an Anthropic key')
    await expect(mainOf(page)).toContainText('This session runs Claude Code on Anthropic keys', agentReply)
    const prompters = (await gatewayLogsOf(workerStack, startedAt)).map((log) => log.metadata?.prompter)
    expect(new Set(prompters)).toEqual(new Set(['member-bob']))
    await bobPage.context().close()
  })

  test('7. a scripted 529 shows HQ’s notice on the turn', async ({ browser, workerStack, agentScript }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ fail: 'Overloaded' }] })
    await sendMessage(bobPage, 'Fail with an overloaded provider')
    await expect(mainOf(bobPage)).toContainText('The provider is unavailable, try again shortly', agentReply)
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
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
    const [first] = await gatewayLogsOf(workerStack, startedAt)
    expect(`${first?.provider}/${first?.model}`).toBe('anthropic/claude-opus-5-5')
    await bobPage.context().close()
  })
})
