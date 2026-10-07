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

const agentReply = { timeout: 60_000 }
const metered = { timeout: 20_000 }
const unchosen = 'Model chosen at first prompt'
const confident = (tier: string, effort = 'high') => ({ route: { tier, confidence: 'high', effort } })
type GatewayLog = { model: string; metadata: Record<string, string> | null }

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', { name: new RegExp(`${unchosen}|· (auto|same as main)$`) })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const openSession = async (page: Page) => {
  await chipOf(page).click()
  await expect(sessionOf(page)).toBeVisible()
}
const repliesOf = (page: Page) => messageItemsOf(page).filter({ hasText: agentReplyText })

const newRuntimeChat = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await dialog.getByText('Runtime', { exact: true }).click()
  await dialog.getByLabel('Chat name').fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  return page.url().split('/').at(-1) ?? ''
}
const promptAndWait = async (page: Page, text: string, replies: number) => {
  await sendMessage(page, text)
  await expect(repliesOf(page)).toHaveCount(replies, agentReply)
}
const agentModelsOf = async (workerStack: WorkerStack, chatId: string, count: number, since = new Date(0)) => {
  let models: string[] = []
  const query = `metadata_chat=${chatId}&metadata_database=${workerStack.databaseName}&start_time=${since.toISOString()}`
  await expect
    .poll(async () => {
      const { logs } = await workerStack.gateway<{ logs: GatewayLog[] | null }>(`/api/logs?${query}&limit=100`)
      models = (logs ?? []).filter((log) => !log.metadata?.role).map((log) => log.model)
      return models.length
    }, agentReply)
    .toBeGreaterThanOrEqual(count)
  return models
}
const addKey = async (page: Page, provider: string) => {
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await llmSection.getByLabel('Provider').fill(provider)
  await llmSection.getByLabel('Secret').fill(`fake-key-${crypto.randomUUID()}`)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: provider })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. before the first prompt the chip says the model is chosen at the first prompt', async ({ page }) => {
  await newRuntimeChat(page, 'Unrouted')
  await expect(chipOf(page)).toHaveText(unchosen)
  await openChat(page, 'Research')
  await expect(chipOf(page)).toHaveText(unchosen)
})

test('2. an easy request runs on the small model', async ({ page, workerStack, agentScript }) => {
  const chatId = await newRuntimeChat(page, 'Easy')
  await agentScript(chatId, confident('small', 'low'))
  await promptAndWait(page, 'What is 2 + 2?', 1)
  await expect(chipOf(page)).toHaveText('Fake small (low) · auto')
  expect(await agentModelsOf(workerStack, chatId, 1)).toEqual(['fake-small'])
})

test('3. a hard request runs on the large model', async ({ page, workerStack, agentScript }) => {
  const chatId = await newRuntimeChat(page, 'Hard')
  await agentScript(chatId, confident('large'))
  await promptAndWait(page, 'Redesign the billing architecture', 1)
  await expect(chipOf(page)).toHaveText('Fake large (high) · auto')
  expect(await agentModelsOf(workerStack, chatId, 1)).toEqual(['fake-large'])
})

test('4. a low-confidence, failed or timed-out classification runs on the chat default model', async ({
  page,
  workerStack,
  agentScript,
}) => {
  for (const [name, route] of [
    ['Low confidence', { tier: 'large', confidence: 'low', effort: 'medium' }],
    ['Classifier failure', 'fail'],
    ['Classifier timeout', 'slow'],
  ] as const) {
    const chatId = await newRuntimeChat(page, name)
    await agentScript(chatId, { route })
    await promptAndWait(page, `Unsure: ${name}`, 1)
    await expect(chipOf(page)).toHaveText('Fake medium (medium) · auto')
    expect(await agentModelsOf(workerStack, chatId, 1)).toEqual(['fake-medium'])
  }
})

test('4b. a chat default changed before the first prompt is used for an unsure session and persists', async ({
  page,
  workerStack,
  agentScript,
}) => {
  const chatId = await newRuntimeChat(page, 'Cheap default')
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Default model')).toHaveValue('fake/fake-medium')
  await sessionOf(page).getByLabel('Default model').selectOption({ label: 'Fake small' })
  await page.reload()
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Default model')).toHaveValue('fake/fake-small')
  await page.keyboard.press('Escape')
  await expect(sessionOf(page)).toBeHidden()

  await agentScript(chatId, { route: { tier: 'large', confidence: 'low', effort: 'medium' } })
  await promptAndWait(page, 'Not sure how hard this is', 1)
  await expect(chipOf(page)).toHaveText('Fake small (medium) · auto')
  expect(await agentModelsOf(workerStack, chatId, 1)).toEqual(['fake-small'])
})

test('5. a member reaching only a small model gets it, and is refused in a session on a model he cannot reach', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addKey(bobPage, 'Fake-small')
  const bobChatId = await newRuntimeChat(bobPage, 'Bob small')
  await agentScript(bobChatId, confident('large'))
  await promptAndWait(bobPage, 'A big refactor please', 1)
  await expect(chipOf(bobPage)).toHaveText('Fake small (high) · auto')
  expect(await agentModelsOf(workerStack, bobChatId, 1)).toEqual(['fake-small'])

  const aliceChatId = await newRuntimeChat(page, 'Alice large')
  await agentScript(aliceChatId, confident('large'))
  await promptAndWait(page, 'Redesign everything', 1)
  await expect(chipOf(page)).toHaveText('Fake large (high) · auto')
  await openChat(bobPage, 'Alice large')
  await sendMessage(bobPage, 'Bob joins the large session')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'Bob joins the large session' })).toBeVisible()
  await expect(mainOf(bobPage)).toContainText(
    'Your keys cannot reach Fake large; switch the model or add a key',
    agentReply,
  )
  expect(await agentModelsOf(workerStack, aliceChatId, 1)).toEqual(['fake-large'])
  await bobPage.context().close()
})

test('6. a later hard prompt keeps the session model', async ({ page, workerStack, agentScript }) => {
  const chatId = await newRuntimeChat(page, 'Locked')
  await agentScript(chatId, confident('small', 'low'))
  await promptAndWait(page, 'Rename a variable', 1)
  await agentScript(chatId, confident('large'))
  await promptAndWait(page, 'Now redesign the whole system', 2)
  await expect(chipOf(page)).toHaveText('Fake small (low) · auto')
  expect(await agentModelsOf(workerStack, chatId, 2)).toEqual(['fake-small', 'fake-small'])
})

test('7 and 8. the manual switch warns about the reread, keeps the history, updates every viewer, and models used lists both', async ({
  page,
  browser,
  workerStack,
}) => {
  const chatId = await newRuntimeChat(page, 'Switched')
  await promptAndWait(page, 'Start on the default', 1)
  await expect(chipOf(page)).toHaveText('Fake medium (medium) · auto')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Switched')
  await expect(chipOf(bobPage)).toHaveText('Fake medium (medium) · auto')

  await openSession(page)
  const modelsUsed = sessionOf(page).getByRole('table', { name: 'Models used in this chat' })
  await expect(modelsUsed.getByRole('row', { name: /^Fake medium/ })).toBeVisible(metered)
  await sessionOf(page).getByLabel('Main model').selectOption({ label: 'Fake large' })
  await expect(sessionOf(page)).toContainText(
    /The next reply rereads the whole conversation with Fake large \(about (\$\d+\.\d{2}|< \$0\.01)\)/,
  )
  await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(page)).toHaveText('Fake large (medium) · auto')
  await expect(chipOf(bobPage)).toHaveText('Fake large (medium) · auto')
  await bobPage.context().close()

  await page.keyboard.press('Escape')
  await promptAndWait(page, 'Continue on large', 2)
  await expect(messageItemsOf(page).filter({ hasText: 'Start on the default' })).toBeVisible()
  await expect(mainOf(page)).not.toContainText('new session')
  expect((await agentModelsOf(workerStack, chatId, 2)).toSorted()).toEqual(['fake-large', 'fake-medium'])

  await openSession(page)
  for (const name of ['Fake medium', 'Fake large']) {
    const row = modelsUsed.getByRole('row', { name: new RegExp(`^${name}`) })
    await expect(row).toBeVisible(metered)
    const [calls = '', tokens = '', cost = ''] = await row.getByRole('cell').allTextContents()
    expect(Number(calls)).toBeGreaterThan(0)
    expect(Number(tokens.replaceAll(',', ''))).toBeGreaterThan(0)
    expect(cost).toMatch(/^(\$\d+\.\d{2}|< \$0\.01)$/)
  }
})

test('9. the subagent policy toggles and persists', async ({ page }) => {
  await newRuntimeChat(page, 'Policy')
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Same as main' })
  await page.reload()
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('same_as_main')
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Auto' })
  await page.reload()
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
})

test.describe('real Agent Server', () => {
  test.use({ agentServer: 'real' })

  test('10. the manual switch reaches the real Agent Server through switch_llm and the relay', async ({
    page,
    workerStack,
  }) => {
    const startedAt = new Date()
    await openChat(page, 'Research')
    await promptAndWait(page, 'Start on the default', 1)
    await expect(chipOf(page)).toHaveText('Fake medium (medium) · auto')
    await openSession(page)
    await sessionOf(page).getByLabel('Main model').selectOption({ label: 'Fake large' })
    await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
    await expect(chipOf(page)).toHaveText('Fake large (medium) · auto')
    await page.keyboard.press('Escape')
    await promptAndWait(page, 'Continue on large', 2)
    await expect(mainOf(page)).not.toContainText('new session')
    expect((await agentModelsOf(workerStack, 'chat-research', 2, startedAt)).toSorted()).toEqual([
      'fake-large',
      'fake-medium',
    ])
  })
})
