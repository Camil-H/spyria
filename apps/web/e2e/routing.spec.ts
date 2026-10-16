import {
  addLlmKey,
  agentReplyText,
  chipOf,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openSession,
  type Page,
  sendMessage,
  sessionOf,
  test,
} from './fixtures'
import { openPageAs } from './stack'

const unchosen = 'Model chosen at first prompt'
const confident = (tier: string, effort = 'high') => ({ route: { tier, confidence: 'high', effort } })

const repliesOf = (page: Page) => messageItemsOf(page).filter({ hasText: agentReplyText })

const promptAndWait = async (page: Page, text: string, replies: number) => {
  await sendMessage(page, text)
  await expect(repliesOf(page)).toHaveCount(replies)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. before the first prompt the chip says the model is chosen at the first prompt', async ({ page }) => {
  await newRuntimeChat(page, 'Unrouted')
  await expect(chipOf(page, 'routed')).toHaveText(unchosen)
  await openChat(page, 'Research')
  await expect(chipOf(page, 'routed')).toHaveText(unchosen)
})

test('4b. a chat default changed before the first prompt is used for an unsure session and persists', async ({
  page,
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
  await expect(chipOf(page, 'routed')).toHaveText('Fake small (medium) · auto')
})

test('5. a member reaching only a small model gets it, and is refused in a session on a model he cannot reach', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake-small')
  const bobChatId = await newRuntimeChat(bobPage, 'Bob small')
  await agentScript(bobChatId, confident('large'))
  await promptAndWait(bobPage, 'A big refactor please', 1)
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake small (high) · auto')

  const aliceChatId = await newRuntimeChat(page, 'Alice large')
  await agentScript(aliceChatId, confident('large'))
  await promptAndWait(page, 'Redesign everything', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (high) · auto')
  await openChat(bobPage, 'Alice large')
  await sendMessage(bobPage, 'Bob joins the large session')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'Bob joins the large session' })).toBeVisible()
  await expect(mainOf(bobPage)).toContainText('Your keys cannot reach Fake large; switch the model or add a key')
  await bobPage.context().close()
})

test('7 and 8. the manual switch warns about the reread, keeps the history and updates every viewer', async ({
  page,
  browser,
  workerStack,
}) => {
  await newRuntimeChat(page, 'Switched')
  await promptAndWait(page, 'Start on the default', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake medium (medium) · auto')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Switched')
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake medium (medium) · auto')

  await openSession(page)
  await sessionOf(page).getByLabel('Main model').selectOption({ label: 'Fake large' })
  await expect(sessionOf(page)).toContainText(
    /The next reply rereads the whole conversation with Fake large \(about (\$\d+\.\d{2}|< \$0\.01)\)/,
  )
  await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (medium) · auto')
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake large (medium) · auto')
  await bobPage.context().close()

  await page.keyboard.press('Escape')
  await promptAndWait(page, 'Continue on large', 2)
  await expect(messageItemsOf(page).filter({ hasText: 'Start on the default' })).toBeVisible()
  await expect(mainOf(page)).not.toContainText('new session')
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

test('11. with a decision model reachable, routing asks it and moves when it is confident', async ({
  page,
  agentScript,
}) => {
  await addLlmKey(page, 'Typesafe')
  const chatId = await newRuntimeChat(page, 'Decided')
  await agentScript(chatId, { route: { tier: 'large', confidence: 0.9, effort: 'high' } })
  await promptAndWait(page, 'Decide', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (high) · auto')
})

test('12. a member whose only key is a decision model is told to add an LLM key and cannot pick it', async ({
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Typesafe')
  await newRuntimeChat(bobPage, 'Bob decides')
  await openSession(bobPage)
  await expect(sessionOf(bobPage).getByLabel('Default model').getByRole('option', { name: 'Jev' })).toHaveCount(0)
  await bobPage.keyboard.press('Escape')
  await sendMessage(bobPage, 'Only a decision key')
  await expect(mainOf(bobPage)).toContainText('Bob has no LLM key in this workspace')
  await bobPage.context().close()
})
