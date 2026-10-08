import {
  agentReplyText,
  expect,
  type Locator,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  sendMessage,
  serverUrl,
  sidebarOf,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const metered = { timeout: 15_000 }
const agentReply = { timeout: 30_000 }
const currentMonth = new Date().toISOString().slice(0, 7)
const earlierMonth = (() => {
  const date = new Date()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
})()

const usageTabOf = (page: Page) => page.getByRole('region', { name: 'Side panel' }).getByRole('tabpanel')
const usageSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Usage' })
const memberTableOf = (page: Page) => usageSectionOf(page).getByRole('table', { name: 'Usage by member' })
const projectTableOf = (page: Page) => usageSectionOf(page).getByRole('table', { name: 'Usage by project' })
const rowOf = (table: Locator, name: string) => table.getByRole('row', { name: new RegExp(`^${name}\\b`) })
const monthPickerOf = (scope: Locator) => scope.getByRole('combobox', { name: 'Month' })

const cellsOf = async (row: Locator) => {
  const [tokens = '', cost = '', calls = ''] = await row.getByRole('cell').allTextContents()
  return {
    tokens: Number(tokens.replaceAll(',', '')),
    cost: cost === '< $0.01' ? 0.001 : Number(cost.replace(/[$,]/g, '')),
    calls: Number(calls),
  }
}

const openUsageTab = async (page: Page, chatName: string) => {
  await openChat(page, chatName)
  await page.getByRole('region', { name: 'Side panel' }).getByRole('tab', { name: 'Usage', exact: true }).click()
}

const openUsageSettings = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
  await expect(usageSectionOf(page).getByRole('heading', { level: 2, name: 'Usage' })).toBeVisible()
}

const prompt = async (page: Page, text: string, expectedReplies: number) => {
  await openChat(page, 'Research')
  await sendMessage(page, text)
  await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toHaveCount(expectedReplies, agentReply)
}

const addFakeKey = async (page: Page) => {
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await llmSection.getByLabel('Provider').fill('Fake')
  await llmSection.getByLabel('Secret').fill(`fake-key-${crypto.randomUUID()}`)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: 'Fake' })).toBeVisible()
}

const expectMeteredRow = async (row: Locator, calls: number) => {
  await expect(row.getByRole('cell').nth(2)).toHaveText(String(calls), metered)
  const cells = await cellsOf(row)
  expect(cells.tokens).toBeGreaterThan(0)
  expect(cells.cost).toBeGreaterThan(0)
}

const researchTotalsInDatabase = async (workerStack: WorkerStack) =>
  workerStack.database.$client`
    select coalesce(sum(tokens), 0)::int as tokens, coalesce(sum(cost_micros), 0)::int as cost_micros,
      coalesce(sum(calls), 0)::int as calls
    from usage_entries where workspace_id = 'workspace-acme' and chat_id = 'chat-research'`

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. a prompt is metered: the Usage tab shows the prompter with tokens, cost and 2 calls (router and agent)', async ({
  page,
}) => {
  await prompt(page, 'Meter this prompt', 1)
  await openUsageTab(page, 'Research')
  const usageTable = usageTabOf(page).getByRole('table')
  await expectMeteredRow(rowOf(usageTable, 'Alice'), 2)
  await expect(rowOf(usageTable, 'Total').getByRole('cell').nth(2)).toHaveText('2')
})

test('2. two prompters each get a row and the total is their sum', async ({ page, browser, workerStack }) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addFakeKey(bobPage)
  await prompt(page, 'Alice asks', 1)
  await prompt(bobPage, 'Bob asks', 2)

  await openUsageTab(page, 'Research')
  const usageTable = usageTabOf(page).getByRole('table')
  await expectMeteredRow(rowOf(usageTable, 'Alice'), 2)
  await expectMeteredRow(rowOf(usageTable, 'Bob'), 1)
  const alice = await cellsOf(rowOf(usageTable, 'Alice'))
  const bob = await cellsOf(rowOf(usageTable, 'Bob'))
  const total = await cellsOf(rowOf(usageTable, 'Total'))
  expect(total.tokens).toBe(alice.tokens + bob.tokens)
  expect(total.calls).toBe(3)
  await bobPage.context().close()
})

test('3. workspace settings show the total, each member and each project', async ({ page, browser, workerStack }) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addFakeKey(bobPage)
  await prompt(page, 'Alice asks', 1)
  await prompt(bobPage, 'Bob asks', 2)
  await bobPage.context().close()

  await openUsageTab(page, 'Research')
  const researchTable = usageTabOf(page).getByRole('table')
  await expect(rowOf(researchTable, 'Alice')).toBeVisible(metered)
  await expect(rowOf(researchTable, 'Bob')).toBeVisible(metered)
  const research = await cellsOf(rowOf(researchTable, 'Total'))
  const aliceInResearch = await cellsOf(rowOf(researchTable, 'Alice'))
  const bobInResearch = await cellsOf(rowOf(researchTable, 'Bob'))
  await openUsageTab(page, 'Invoice bug')
  const invoiceTable = usageTabOf(page).getByRole('table')
  await expect(rowOf(invoiceTable, 'Total')).toContainText('15,500')
  const invoiceBug = await cellsOf(rowOf(invoiceTable, 'Total'))
  const aliceInInvoiceBug = await cellsOf(rowOf(invoiceTable, 'Alice'))
  const bobInInvoiceBug = await cellsOf(rowOf(invoiceTable, 'Bob'))

  await openUsageSettings(page)
  await expect(monthPickerOf(usageSectionOf(page))).toHaveValue(currentMonth)
  await expect(rowOf(projectTableOf(page), 'No project')).toBeVisible()
  expect(await cellsOf(rowOf(projectTableOf(page), 'No project'))).toEqual(research)
  expect((await cellsOf(rowOf(projectTableOf(page), 'Billing'))).tokens).toBe(invoiceBug.tokens)
  expect((await cellsOf(rowOf(memberTableOf(page), 'Alice'))).tokens).toBe(
    aliceInResearch.tokens + aliceInInvoiceBug.tokens,
  )
  expect((await cellsOf(rowOf(memberTableOf(page), 'Bob'))).tokens).toBe(bobInResearch.tokens + bobInInvoiceBug.tokens)
  const workspaceTotal = await cellsOf(rowOf(memberTableOf(page), 'Total'))
  expect(workspaceTotal.tokens).toBe(research.tokens + invoiceBug.tokens)
  expect(workspaceTotal.calls).toBe(research.calls + invoiceBug.calls)
})

test('4. a row of an earlier month appears only when that month is picked, in both views', async ({
  page,
  workerStack,
}) => {
  await workerStack.database.$client`
    insert into usage_entries (workspace_id, month, chat_id, user_id, tokens, cost_micros, calls)
    values ('workspace-acme', ${earlierMonth}, 'chat-research', 'member-alice', 4321, 70000, 3)`

  await openUsageTab(page, 'Research')
  const usageTable = usageTabOf(page).getByRole('table')
  await expect(monthPickerOf(usageTabOf(page))).toHaveValue(currentMonth)
  await expect(rowOf(usageTable, 'Total')).not.toContainText('4,321')
  await monthPickerOf(usageTabOf(page)).selectOption(earlierMonth)
  await expect(rowOf(usageTable, 'Alice')).toContainText('4,321')
  await expect(rowOf(usageTable, 'Alice')).toContainText('$0.07')
  await expect(rowOf(usageTable, 'Alice').getByRole('cell').nth(2)).toHaveText('3')

  await openUsageSettings(page)
  await expect(projectTableOf(page)).not.toContainText('4,321')
  await monthPickerOf(usageSectionOf(page)).selectOption(earlierMonth)
  await expect(rowOf(projectTableOf(page), 'No project')).toContainText('4,321')
  await expect(rowOf(memberTableOf(page), 'Alice')).toContainText('4,321')
  await expect(rowOf(memberTableOf(page), 'Total')).toContainText('$0.07')
  await expect(projectTableOf(page)).not.toContainText('15,500')
})

test.describe('5. as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('Bob has no Usage section in settings but sees every prompter in the chat Usage tab', async ({ page }) => {
    await page.goto('/w/workspace-acme/settings')
    await expect(mainOf(page).getByText('Only workspace admins can see this page')).toBeVisible()
    await expect(usageSectionOf(page)).toHaveCount(0)

    await openUsageTab(page, 'Invoice bug')
    const usageTable = usageTabOf(page).getByRole('table')
    await expect(rowOf(usageTable, 'Alice')).toContainText('12,400')
    await expect(rowOf(usageTable, 'Bob')).toContainText('3,100')
    await expect(rowOf(usageTable, 'Total')).toContainText('15,500')
  })
})

test('6. running the sync twice over the same window leaves the totals unchanged', async ({ page, workerStack }) => {
  await prompt(page, 'Count me once', 1)
  await openUsageTab(page, 'Research')
  const usageTable = usageTabOf(page).getByRole('table')
  await expectMeteredRow(rowOf(usageTable, 'Alice'), 2)
  const before = await cellsOf(rowOf(usageTable, 'Total'))
  const totalsBefore = await researchTotalsInDatabase(workerStack)

  for (const _run of [1, 2]) {
    const synced = await fetch(`${serverUrl}/test/usage-sync?db=${workerStack.databaseName}`, { method: 'POST' })
    expect(synced.ok).toBe(true)
  }

  expect(await researchTotalsInDatabase(workerStack)).toEqual(totalsBefore)
  await page.reload()
  await openUsageTab(page, 'Research')
  await expect(rowOf(usageTable, 'Total').getByRole('cell').nth(2)).toHaveText('2')
  expect(await cellsOf(rowOf(usageTable, 'Total'))).toEqual(before)
})
