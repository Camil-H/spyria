import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  expect,
  type Locator,
  mainOf,
  messageContaining,
  openChat,
  openPanelTab,
  openSettings,
  type Page,
  sendMessage,
  serverUrl,
  tabPanelOf,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const currentMonth = new Date().toISOString().slice(0, 7)
const earlierMonth = (() => {
  const date = new Date()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
})()

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

const openUsageTab = (page: Page, chatName: string) => openPanelTab(page, chatName, 'Usage')

const openUsageSettings = async (page: Page) => {
  await openSettings(page, 'Analyze costs')
  await expect(usageSectionOf(page).getByRole('heading', { level: 2, name: 'Usage' })).toBeVisible()
}

const syncUsage = async (workerStack: WorkerStack) => {
  const synced = await fetch(`${serverUrl}/test/usage-sync?db=${workerStack.databaseName}`, { method: 'POST' })
  expect(synced.ok).toBe(true)
}

const researchTotalsInDatabase = async (workerStack: WorkerStack) =>
  workerStack.database.$client`
    select coalesce(sum(tokens), 0)::int as tokens, coalesce(sum(cost_micros), 0)::int as cost_micros,
      coalesce(sum(calls), 0)::int as calls
    from usage_entries where workspace_id = 'workspace-acme' and chat_id = 'chat-research'`

const syncUntilResearchCalls = (workerStack: WorkerStack, calls: number) =>
  expect
    .poll(
      async () => {
        await syncUsage(workerStack)
        return (await researchTotalsInDatabase(workerStack))[0]?.calls
      },
      { intervals: [100] },
    )
    .toBe(calls)

const prompt = async (page: Page, text: string, expectedReplies: number) => {
  await openChat(page, 'Research')
  await sendMessage(page, text)
  await expect(messageContaining(page, agentReplyText)).toHaveCount(expectedReplies)
}

const expectMeteredRow = async (row: Locator, calls: number) => {
  await expect(row.getByRole('cell').nth(2)).toHaveText(String(calls))
  const cells = await cellsOf(row)
  expect(cells.tokens).toBeGreaterThan(0)
  expect(cells.cost).toBeGreaterThan(0)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('3. two prompters each get a row, the total is their sum, and workspace settings show the total, each member and each project', async ({
  page,
  browser,
  workerStack,
}) => {
  await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await prompt(page, 'Alice asks', 1)
  await prompt(bobPage, 'Bob asks', 2)
  await syncUntilResearchCalls(workerStack, 3)
  await bobPage.context().close()

  await openUsageTab(page, 'Research')
  const researchTable = tabPanelOf(page).getByRole('table')
  await expectMeteredRow(rowOf(researchTable, 'Alice'), 2)
  await expectMeteredRow(rowOf(researchTable, 'Bob'), 1)
  const research = await cellsOf(rowOf(researchTable, 'Total'))
  const aliceInResearch = await cellsOf(rowOf(researchTable, 'Alice'))
  const bobInResearch = await cellsOf(rowOf(researchTable, 'Bob'))
  expect(research.tokens).toBe(aliceInResearch.tokens + bobInResearch.tokens)
  expect(research.calls).toBe(3)
  await openUsageTab(page, 'Invoice bug')
  const invoiceTable = tabPanelOf(page).getByRole('table')
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
  const usageTable = tabPanelOf(page).getByRole('table')
  await expect(monthPickerOf(tabPanelOf(page))).toHaveValue(currentMonth)
  await expect(rowOf(usageTable, 'Total')).not.toContainText('4,321')
  await monthPickerOf(tabPanelOf(page)).selectOption(earlierMonth)
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
    await page.goto('/w/workspace-acme/settings/costs')
    await expect(mainOf(page).getByText('Only workspace admins can see this page')).toBeVisible()
    await expect(usageSectionOf(page)).toHaveCount(0)

    await openUsageTab(page, 'Invoice bug')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(rowOf(usageTable, 'Alice')).toContainText('12,400')
    await expect(rowOf(usageTable, 'Bob')).toContainText('3,100')
    await expect(rowOf(usageTable, 'Total')).toContainText('15,500')
  })
})
