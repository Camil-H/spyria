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

const agentReply = { timeout: 90_000 }
const metered = { timeout: 30_000 }
const researchChatId = 'chat-research'
const answer = 'The command printed hello.'
type GatewayLog = { provider: string; model: string; timestamp: string; metadata: Record<string, string> | null }

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', { name: /^Model chosen at first prompt$|^Codex · |· (auto|same as main)$/ })
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
  await addKey(bobPage, 'OpenAI')
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

  test('1. a member whose only key is OpenAI gets Codex: the chip, a command step, the answer, Usage on the prompter, and openai/gpt-6.1-sol at the gateway', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const startedAt = new Date()
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ command: 'echo hello from codex' }], text: answer })
    await sendMessage(bobPage, 'Say hello from the terminal')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
    await expect(chipOf(bobPage)).toHaveText('Codex · gpt-6.1-sol')
    await messageItemsOf(bobPage)
      .getByRole('button', { name: /echo hello from codex/ })
      .click()
    await expect(messageItemsOf(bobPage).locator('pre')).toHaveText('hello from codex')
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
    const [first] = await gatewayLogsOf(workerStack, startedAt)
    expect(`${first?.provider}/${first?.model}`).toBe('openai/gpt-6.1-sol')
    await bobPage.context().close()
  })

  test('2. an invitee without an OpenAI key prompting a Codex session gets the notice and no gateway call', async ({
    page,
    browser,
    workerStack,
    agentScript,
  }) => {
    const startedAt = new Date()
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { text: answer })
    await sendMessage(bobPage, 'Start the Codex session')
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
    await openChat(page, 'Research')
    await sendMessage(page, 'Alice joins without an OpenAI key')
    await expect(mainOf(page)).toContainText('This session runs Codex on OpenAI keys', agentReply)
    const prompters = (await gatewayLogsOf(workerStack, startedAt)).map((log) => log.metadata?.prompter)
    expect(new Set(prompters)).toEqual(new Set(['member-bob']))
    await bobPage.context().close()
  })

  test('3. a scripted personal tool call from Codex runs as the owner and shows as a step', async ({
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
    await expect(messageItemsOf(bobPage).filter({ hasText: answer })).toBeVisible(agentReply)
    await messageItemsOf(bobPage).getByRole('button', { name: 'Used whoami (fake)' }).click()
    await expect(mainOf(bobPage)).toContainText(`you are ${account}`)
    await bobPage.context().close()
  })

  test('4. stopping mid-command marks the turn stopped, and the next prompt is answered once in the resumed Codex session', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ command: 'sleep 60' }], text: 'Never shown.' })
    await sendMessage(bobPage, 'Run the long command')
    await expect(messageItemsOf(bobPage).getByRole('img', { name: 'Running' })).toBeVisible(agentReply)
    await mainOf(bobPage).getByRole('button', { name: 'Stop' }).click()
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Stopped by Bob' })).toHaveCount(1, agentReply)
    await agentScript(researchChatId, { text: 'Back after the stop.' })
    await sendMessage(bobPage, 'Answer after the stop')
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Back after the stop.' })).toHaveCount(1, agentReply)
    await expect(bobPage.getByRole('status', { name: 'Agent is working' })).toHaveCount(0, agentReply)
    await expect(mainOf(bobPage)).not.toContainText('Never shown.')
    await expect(mainOf(bobPage)).not.toContainText('Codex restarted without its earlier context')
    await expect(messageItemsOf(bobPage).filter({ hasText: agentReplyText })).toHaveCount(0)
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Stopped by Bob' })).toHaveCount(1)
    const sessionIds = await workerStack.database.$client`
      select distinct payload->'event'->'value'->>'acp_session_id' as id from events
      where chat_id = ${researchChatId} and payload->'event'->>'key' = 'agent_state'`
    expect(sessionIds).toHaveLength(1)
    await bobPage.context().close()
  })

  test('5. a scripted 529 shows HQ’s notice on the turn, not Codex’s own answer', async ({
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await bobInResearch(browser, workerStack)
    await agentScript(researchChatId, { steps: [{ fail: 'Overloaded' }] })
    await sendMessage(bobPage, 'Fail with an overloaded provider')
    await expect(mainOf(bobPage)).toContainText('The provider is unavailable, try again shortly', agentReply)
    await expect(mainOf(bobPage)).not.toContainText('Bad Request')
    await bobPage.context().close()
  })
})
