import { seedModelCall } from '@spyria/db/testing'
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
} from '../fixtures'
import { openPageAs, type WorkerStack } from '../stack'

const bobNotice =
  "Bob's daily AI budget is used up; a member with the Manage budgets permission can raise it in Workspace settings"
const budgetsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'AI budgets' })
const budgetGridOf = (page: Page) => budgetsOf(page).getByRole('table', { name: 'AI budgets per role' })
const roleRowOf = (page: Page, role: string) => budgetGridOf(page).getByRole('row', { name: new RegExp(`^${role}\\b`) })
const myUsageOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My usage' })
const budgetAlertOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Budget alert' })

const spend = (workerStack: WorkerStack, prompterId: string, costMicros: number) =>
  seedModelCall(workerStack.database, prompterId, costMicros)
const seedDailyBudget = (workerStack: WorkerStack, roleId: string, limitMicros: number) =>
  workerStack.database.$client`
    insert into role_budgets (workspace_id, role_id, period, limit_micros)
    values ('workspace-acme', ${roleId}, 'day', ${limitMicros})`
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

const openBudgets = async (page: Page) => {
  await openSettings(page, 'Costs and AI budgets')
  await mainOf(page).getByRole('tab', { name: 'AI budgets' }).click()
}
const saveDailyBudget = async (page: Page, role: string, dollars: string) => {
  const row = roleRowOf(page, role)
  await row.getByRole('spinbutton', { name: `Daily budget per member of ${role}` }).fill(dollars)
  await row.getByRole('button', { name: `Save the budgets of ${role}` }).click()
}
const openBobInResearch = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
  await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Mistral')
  await openChat(bobPage, 'Research')
  return bobPage
}
const prompt = async (page: Page, text: string) => {
  await expect(composerOf(page)).toBeEditable()
  await sendMessage(page, text)
}

test.describe('Budgets', () => {
  test.beforeEach(async ({ page, workerStack }) => {
    await workerStack.database.$client`delete from usage_entries where workspace_id = 'workspace-acme'`
    await page.goto('/')
  })

  test('As a member who can manage budgets, I give the Member role a daily budget of $1 per member: each of its 2 members gets $1, the role totals $2, the workspace total adds up the roles, and Bob at $0.70 sees $0.70 of $1 (70%)', {
    tag: ['@spec-46'],
  }, async ({ page, browser, workerStack }) => {
    await spend(workerStack, 'member-bob', 700_000)
    await openBudgets(page)
    await expect(budgetsOf(page)).toContainText('not shared by the members who hold it')
    await saveDailyBudget(page, 'Member', '1')
    await expect(roleRowOf(page, 'Member')).toContainText('$1.00 × 2 members = $2.00')
    const workspaceTotal = budgetGridOf(page).getByRole('row', { name: /^Workspace total\b/ })
    await expect(workspaceTotal.getByRole('cell').nth(1)).toHaveText('No limit')
    await expect(workspaceTotal.getByRole('spinbutton')).toHaveCount(0)
    await saveDailyBudget(page, 'Admin', '5')
    await expect(roleRowOf(page, 'Admin')).toContainText('$5.00 × 1 member = $5.00')
    await expect(workspaceTotal.getByRole('cell').nth(1)).toHaveText('$7.00')

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openProfile(bobPage, 'Usage')
    const bar = myUsageOf(bobPage).getByRole('progressbar', { name: 'Daily AI budget used' })
    await expect(bar).toHaveAttribute('aria-valuenow', '70')
    await expect(myUsageOf(bobPage)).toContainText('$0.70 of $1.00 (70%)')
    await syncUsage(workerStack)
    await expect(budgetAlertOf(bobPage)).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member with a budget, my prompt past 80% shows the notice above my composer and in My usage, and those who manage budgets see the card badge and me over 80%', {
    tag: ['@spec-46'],
  }, async ({ page, browser, workerStack }) => {
    await spend(workerStack, 'member-bob', 799_999)
    await seedDailyBudget(workerStack, 'member', 1_000_000)
    const bobPage = await openBobInResearch(browser, workerStack)
    await syncUsage(workerStack)
    await expect(budgetAlertOf(bobPage)).toHaveCount(0)
    await prompt(bobPage, 'Push me past 80%')
    await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
    await syncUntilAlert(workerStack, bobPage, 'You have used 80% of your daily AI budget')

    await openProfile(bobPage, 'Usage')
    await expect(myUsageOf(bobPage).getByRole('status', { name: 'Budget alert' })).toHaveText(
      'You have used 80% of your daily AI budget',
    )
    await bobPage.context().close()

    const card = mainOf(page).getByRole('link', { name: 'Costs and AI budgets', exact: true })
    await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: 'Workspace settings' }).click()
    await expect(card).toContainText('1 budget alert')
    await card.click()
    await expect(mainOf(page).getByText('1 member has a budget alert.')).toBeVisible()
    await mainOf(page).getByRole('button', { name: 'See the AI budgets' }).click()
    await expect(budgetsOf(page).getByRole('region', { name: 'Over 80% of their budget' })).toContainText(
      /Bob · daily · \$0\.80 of \$1\.00 \(80%\)/,
    )
  })

  test('As a member at 100% of my daily budget, my next prompt is refused with the budget notice and no model call reaches the gateway, while an admin without a budget is answered', {
    tag: ['@spec-46', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    await spend(workerStack, 'member-bob', 1_000_000)
    await seedDailyBudget(workerStack, 'member', 1_000_000)
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

  test('As a member who can manage budgets, I raise the Member role’s daily budget to $2 and Bob’s next prompt is answered', {
    tag: ['@spec-46'],
  }, async ({ page, browser, workerStack }) => {
    await spend(workerStack, 'member-bob', 1_000_000)
    await seedDailyBudget(workerStack, 'member', 1_000_000)
    const bobPage = await openBobInResearch(browser, workerStack)
    await prompt(bobPage, 'Over budget')
    await expect(messageItemsOf(bobPage).getByRole('alert')).toContainText(bobNotice)

    await openBudgets(page)
    await saveDailyBudget(page, 'Member', '2')
    await expect(roleRowOf(page, 'Member')).toContainText('$2.00 × 2 members = $4.00')
    await prompt(bobPage, 'Back under budget')
    await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
    await bobPage.context().close()
  })

  test('As a member with a budget, I see my own budget only and am refused the budgets page', {
    tag: ['@spec-46'],
  }, async ({ browser, workerStack }) => {
    await spend(workerStack, 'member-bob', 900_000)
    await seedDailyBudget(workerStack, 'member', 3_000_000)

    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await openProfile(leePage, 'Usage')
    await expect(myUsageOf(leePage)).toContainText('$0.00 of $3.00 (0%)')
    await expect(mainOf(leePage)).not.toContainText('Bob')
    await expect(mainOf(leePage)).not.toContainText('$0.90')
    await leePage.goto('/w/workspace-acme/settings/costs')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'AI budgets' })).toHaveCount(0)
    await leePage.context().close()
  })
})
