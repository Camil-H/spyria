import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  composerOf,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openProfile,
  openSettings,
  type Page,
  sendMessage,
  serverUrl,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const bobNotice = "Bob's monthly AI budget is used up; an admin can raise it in Workspace settings"
const workspaceNotice = "The workspace's monthly AI budget is used up; an admin can raise it in Workspace settings"
const budgetsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Budgets' })
const budgetRowOf = (page: Page, name: string) =>
  budgetsOf(page)
    .getByRole('table', { name: 'Budgets' })
    .getByRole('row', { name: new RegExp(`^${name}\\b`) })
const myUsageOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My usage' })
const budgetAlertOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Budget alert' })

const spend = (workerStack: WorkerStack, prompterId: string, costMicros: number) =>
  workerStack.database.$client`
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens,
      output_tokens, cost_micros, status, called_at)
    values ('workspace-acme', ${`call-${crypto.randomUUID()}`}, 'chat-research', ${prompterId}, null, 'fake-model',
      'fake', 1, 1, ${costMicros}, 'success', now())`
const seedBudget = (workerStack: WorkerStack, memberId: string | null, limitMicros: number) =>
  workerStack.database.$client`
    insert into budgets (workspace_id, member_id, limit_micros) values ('workspace-acme', ${memberId}, ${limitMicros})`
const modelCallsOf = async (workerStack: WorkerStack, prompterId: string) =>
  (
    await workerStack.database.$client`
      select count(*)::int as count from model_calls where workspace_id = 'workspace-acme' and prompter_id = ${prompterId}`
  )[0]?.count
const syncUsage = async (workerStack: WorkerStack) => {
  expect((await fetch(`${serverUrl}/test/usage-sync?db=${workerStack.databaseName}`, { method: 'POST' })).ok).toBe(true)
}
const syncUntilAlert = (workerStack: WorkerStack, page: Page, text: string) =>
  expect(async () => {
    await syncUsage(workerStack)
    await expect(budgetAlertOf(page)).toHaveText(text, { timeout: 1_000 })
  }).toPass({ timeout: 20_000 })

const saveBudget = async (page: Page, name: string, dollars: string) => {
  const row = budgetRowOf(page, name)
  await row.getByRole('spinbutton', { name: `Monthly budget of ${name}` }).fill(dollars)
  await row.getByRole('button', { name: `Save the budget of ${name}` }).click()
}
const openBobInResearch = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
  await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Research')
  return bobPage
}
const prompt = async (page: Page, text: string) => {
  await expect(composerOf(page)).toBeEditable()
  await sendMessage(page, text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. Alice sets Bob’s monthly budget to $1 with Bob at $0.70: Bob’s My usage shows $0.70 of $1 (70%), no alert', async ({
  page,
  browser,
  workerStack,
}) => {
  await spend(workerStack, 'member-bob', 700_000)
  await openSettings(page, 'Analyze costs')
  await expect(budgetRowOf(page, 'Bob')).toContainText('$0.70')
  await saveBudget(page, 'Bob', '1')
  await expect(budgetRowOf(page, 'Bob').getByRole('cell').nth(1)).toHaveText('70%')

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openProfile(bobPage)
  const bar = myUsageOf(bobPage).getByRole('progressbar', { name: 'Monthly AI budget used' })
  await expect(bar).toHaveAttribute('aria-valuenow', '70')
  await expect(myUsageOf(bobPage)).toContainText('$0.70 of $1.00 (70%)')
  await syncUsage(workerStack)
  await expect(budgetAlertOf(bobPage)).toHaveCount(0)
  await bobPage.context().close()
})

test('2. Bob’s next prompt brings him past $0.80: the 80% notice shows above his composer and in My usage; the Analyze costs card has a badge and the page lists Bob over 80%', async ({
  page,
  browser,
  workerStack,
}) => {
  await spend(workerStack, 'member-bob', 799_999)
  await seedBudget(workerStack, 'member-bob', 1_000_000)
  const bobPage = await openBobInResearch(browser, workerStack)
  await syncUsage(workerStack)
  await expect(budgetAlertOf(bobPage)).toHaveCount(0)
  await prompt(bobPage, 'Push me past 80%')
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
  await syncUntilAlert(workerStack, bobPage, 'You have used 80% of your monthly AI budget')

  await openProfile(bobPage)
  await expect(myUsageOf(bobPage).getByRole('status', { name: 'Budget alert' })).toHaveText(
    'You have used 80% of your monthly AI budget',
  )
  await bobPage.context().close()

  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('link', { name: 'Analyze costs', exact: true })).toContainText('1 budget alert')
  await mainOf(page).getByRole('link', { name: 'Analyze costs', exact: true }).click()
  await expect(budgetsOf(page).getByRole('region', { name: 'Over 80% of their budget' })).toContainText(
    /Bob · \$0\.80 of \$1\.00 \(80%\)/,
  )
})

test('3. Bob reaches $1: his next prompt is refused with the budget notice and no model call reaches the gateway', async ({
  page,
  browser,
  workerStack,
}) => {
  await spend(workerStack, 'member-bob', 1_000_000)
  await seedBudget(workerStack, 'member-bob', 1_000_000)
  const bobPage = await openBobInResearch(browser, workerStack)
  await syncUntilAlert(workerStack, bobPage, bobNotice.replace("Bob's", 'Your'))
  await prompt(bobPage, 'Over budget')
  await expect(messageItemsOf(bobPage).getByRole('alert')).toContainText(bobNotice)
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(0)

  await openChat(page, 'Research')
  await prompt(page, 'Alice has no budget')
  await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  await expect
    .poll(async () => {
      await syncUsage(workerStack)
      return modelCallsOf(workerStack, 'member-alice')
    })
    .toBeGreaterThan(0)
  expect(await modelCallsOf(workerStack, 'member-bob')).toBe(1)
  await bobPage.context().close()
})

test('4. Alice raises Bob’s budget to $2: Bob’s next prompt is answered', async ({ page, browser, workerStack }) => {
  await spend(workerStack, 'member-bob', 1_000_000)
  await seedBudget(workerStack, 'member-bob', 1_000_000)
  const bobPage = await openBobInResearch(browser, workerStack)
  await prompt(bobPage, 'Over budget')
  await expect(messageItemsOf(bobPage).getByRole('alert')).toContainText(bobNotice)

  await openSettings(page, 'Analyze costs')
  await saveBudget(page, 'Bob', '2')
  await expect(budgetRowOf(page, 'Bob').getByRole('cell').nth(1)).toHaveText('50%')
  await prompt(bobPage, 'Back under budget')
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
  await bobPage.context().close()
})

test('5. a reached workspace total of $1.50 refuses every member’s prompts with the workspace wording; removing it restores them', async ({
  page,
  browser,
  workerStack,
}) => {
  await spend(workerStack, 'member-alice', 1_000_000)
  await spend(workerStack, 'member-bob', 500_000)
  const bobPage = await openBobInResearch(browser, workerStack)
  await openSettings(page, 'Analyze costs')
  await saveBudget(page, 'Workspace total', '1.5')
  await expect(budgetRowOf(page, 'Workspace total').getByRole('cell').nth(1)).toHaveText('100%')

  await prompt(bobPage, 'Bob over the workspace total')
  await expect(messageItemsOf(bobPage).getByRole('alert')).toContainText(workspaceNotice)
  await openChat(page, 'Research')
  await prompt(page, 'Alice over the workspace total')
  await expect(messageItemsOf(page).getByRole('alert')).toHaveCount(2)
  await expect(messageItemsOf(page).getByRole('alert').last()).toContainText(workspaceNotice)

  await openSettings(page, 'Analyze costs')
  await saveBudget(page, 'Workspace total', '')
  await expect(budgetRowOf(page, 'Workspace total').getByRole('cell').nth(1)).toHaveText('—')
  await openChat(page, 'Research')
  await prompt(page, 'Alice after the removal')
  await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  await prompt(bobPage, 'Bob after the removal')
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(2)
  await bobPage.context().close()
})

test('6. Lee sees his own budget only; the budget change appears in the Audit log', async ({
  page,
  browser,
  workerStack,
}) => {
  await spend(workerStack, 'member-bob', 900_000)
  await seedBudget(workerStack, 'member-bob', 1_000_000)
  await openSettings(page, 'Analyze costs')
  await saveBudget(page, 'Lee', '3')
  await expect(budgetRowOf(page, 'Lee').getByRole('cell').nth(1)).toHaveText('0%')

  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await openProfile(leePage)
  await expect(myUsageOf(leePage)).toContainText('$0.00 of $3.00 (0%)')
  await expect(mainOf(leePage)).not.toContainText('Bob')
  await expect(mainOf(leePage)).not.toContainText('$0.90')
  await leePage.goto('/w/workspace-acme/settings/costs')
  await expect(mainOf(leePage)).toContainText('Only workspace admins can see this page')
  await expect(mainOf(leePage).getByRole('region', { name: 'Budgets' })).toHaveCount(0)
  await leePage.context().close()

  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Audit log', exact: true }).click()
  const records = mainOf(page).getByRole('list', { name: 'Audit records' }).getByRole('listitem')
  await expect(records.filter({ hasText: /Alice\s*Changed a monthly AI budget\s*Lee/ })).toHaveCount(1)
})
