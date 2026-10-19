import { seedSpend } from '@hq/db/testing'
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
  openProfile,
  openSettings,
  type Page,
  sendMessage,
  serverUrl,
  tabPanelOf,
  test,
} from '../fixtures'
import { openPageAs, type WorkerStack } from '../stack'

test.describe('Spend', () => {
  test.describe(() => {
    const usageSectionOf = (page: Page, title: string) => mainOf(page).getByRole('region', { name: title })
    const tableOf = (section: Locator, label: string) => section.getByRole('table', { name: label })
    const rowOf = (table: Locator, name: string) =>
      table.getByRole('row', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`) })
    const cellTextsOf = (row: Locator) => row.getByRole('cell').allTextContents()
    const legendOf = (section: Locator) => section.getByRole('list', { name: 'Legend' }).getByRole('listitem')

    test.beforeEach(async ({ page, workerStack }) => {
      await workerStack.database.transaction((transaction) => seedSpend(transaction))
      await page.goto('/')
    })

    test('As a member who can view costs, I analyze this month by day: the chart and the member, project, chat and model tables match the seed, and by model restacks the chart', {
      tag: ['@spec-45', '@smoke'],
    }, async ({ page }) => {
      await openSettings(page, 'Analyze costs')
      const section = usageSectionOf(page, 'Usage')
      await expect(section.getByRole('combobox', { name: 'Period' })).toHaveValue('this_month')
      await expect(section.getByRole('radio', { name: 'Day' })).toBeChecked()
      await expect(section.getByRole('img', { name: 'Spend over time by member' })).toBeVisible()
      await expect(legendOf(section)).toHaveText(['Alice$0.04', 'Lee$0.02', 'Bob$0.02'])
      const expectedRows = {
        'Usage by member': [
          ['Alice', ['4,000', '$0.04', '4', '50%']],
          ['Lee', ['2,000', '$0.02', '2', '25%']],
          ['Bob', ['2,000', '$0.02', '2', '25%']],
        ],
        'Usage by project': [
          ['Billing', ['4,000', '$0.04', '4', '50%']],
          ['No project', ['2,000', '$0.02', '2', '25%']],
          ['Onboarding', ['2,000', '$0.02', '2', '25%']],
        ],
        'Usage by chat': [
          ['Invoice bug', ['4,000', '$0.04', '4', '50%']],
          ['Research', ['2,000', '$0.02', '2', '25%']],
          ['Setup helper', ['2,000', '$0.02', '2', '25%']],
        ],
        'Usage by model': [
          ['openai/gpt-5', ['4,000', '$0.04', '4', '50%']],
          ['anthropic/claude-sonnet', ['3,000', '$0.03', '3', '38%']],
          ['openai/gpt-5-mini', ['1,000', '$0.01', '1', '13%']],
        ],
      } as const
      for (const [label, rows] of Object.entries(expectedRows)) {
        const table = tableOf(section, label)
        await expect(table.getByRole('row')).toHaveCount(rows.length + 2)
        for (const [name, cells] of rows) expect(await cellTextsOf(rowOf(table, name))).toEqual([...cells])
        expect(await cellTextsOf(rowOf(table, 'Total'))).toEqual(['8,000', '$0.08', '8', '100%'])
      }

      await section.getByRole('radio', { name: 'Model' }).check()
      await expect(section.getByRole('img', { name: 'Spend over time by model' })).toBeVisible()
      await expect(legendOf(section)).toHaveText([
        'openai/gpt-5$0.04',
        'anthropic/claude-sonnet$0.03',
        'openai/gpt-5-mini$0.01',
      ])
    })

    test('As a member who can view costs, I see the spend decomposed into six factors against last month, tokens per request highlighted as the biggest mover', {
      tag: ['@spec-45'],
    }, async ({ page }) => {
      await openSettings(page, 'Analyze costs')
      const decomposition = tableOf(usageSectionOf(page, 'Usage'), 'Spend decomposition')
      const expectedFactors = [
        ['Users', ['3', '3', '0%']],
        ['Sessions per user', ['1', '1', '0%']],
        ['Turns per session', ['1.33', '1.33', '0%']],
        ['Requests per turn', ['2', '2', '0%']],
        ['Tokens per request', ['1,000', '500', '+100%']],
        ['Price per 1M tokens', ['$10.00', '$10.00', '0%']],
      ] as const
      await expect(decomposition.getByRole('row')).toHaveCount(expectedFactors.length + 1)
      for (const [name, cells] of expectedFactors)
        expect(await cellTextsOf(rowOf(decomposition, name))).toEqual([...cells])
      const biggestMover = decomposition.locator('tr[aria-current="true"]')
      await expect(biggestMover).toHaveCount(1)
      await expect(biggestMover.getByRole('rowheader')).toHaveText('Tokens per request · Biggest mover')
      await expect(usageSectionOf(page, 'Spend decomposition')).toContainText(
        'Spend $0.08 against $0.04 in the previous period (+100%)',
      )
    })

    test('As a member who can view costs, I see the cost per merged PR with each merged PR and its chat’s cost', {
      tag: ['@spec-45'],
    }, async ({ page }) => {
      await openSettings(page, 'Analyze costs')
      const mergedPulls = usageSectionOf(page, 'Cost per merged PR')
      await expect(mergedPulls).toContainText('$0.06 per merged PR · 1 merged · $0.06 spent in their chats')
      const table = tableOf(mergedPulls, 'Merged pull requests')
      expect(await cellTextsOf(rowOf(table, 'Invoice bug'))).toEqual(['acme/app#7 Fix the invoice total', '$0.06'])
      await expect(table.getByRole('link', { name: 'acme/app#7' })).toHaveAttribute(
        'href',
        'https://github.com/acme/app/pull/7',
      )
    })

    test.describe(() => {
      test.use({ signedInAs: 'member-bob' })

      test('As a member, I see only my own usage in my Profile, per chat and per model, with my decomposition', {
        tag: ['@spec-45'],
      }, async ({ page }) => {
        await openProfile(page)
        const section = usageSectionOf(page, 'My usage')
        await expect(section).toContainText('$0.02 · 2 requests')
        await expect(legendOf(section)).toHaveText(['openai/gpt-5$0.02'])
        const chats = tableOf(section, 'Usage by chat')
        await expect(chats.getByRole('row')).toHaveCount(3)
        expect(await cellTextsOf(rowOf(chats, 'Research'))).toEqual(['2,000', '$0.02', '2', '100%'])
        const models = tableOf(section, 'Usage by model')
        await expect(models.getByRole('row')).toHaveCount(3)
        expect(await cellTextsOf(rowOf(models, 'openai/gpt-5'))).toEqual(['2,000', '$0.02', '2', '100%'])
        expect(await cellTextsOf(rowOf(tableOf(section, 'Spend decomposition'), 'Users'))).toEqual(['1', '1', '0%'])
        await expect(section.getByRole('table', { name: 'Usage by member' })).toHaveCount(0)
        await expect(section).not.toContainText(/Alice|Lee|Invoice bug|claude/)
      })
    })
  })

  test.describe(() => {
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
    const periodPickerOf = (page: Page) => usageSectionOf(page).getByRole('combobox', { name: 'Period' })

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

    test('As a member who can view costs, I see each prompter’s row in a chat’s Usage tab summing to the total, and the workspace total, each member and each project in settings', {
      tag: ['@spec-13'],
    }, async ({ page, browser, workerStack }) => {
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

      expect(invoiceBug.tokens).toBe(aliceInInvoiceBug.tokens + bobInInvoiceBug.tokens)

      await openUsageSettings(page)
      await expect(periodPickerOf(page)).toHaveValue('this_month')
      await expect(rowOf(projectTableOf(page), 'No project')).toBeVisible()
      expect(await cellsOf(rowOf(projectTableOf(page), 'No project'))).toEqual(research)
      await expect(rowOf(projectTableOf(page), 'Billing')).toHaveCount(0)
      expect((await cellsOf(rowOf(memberTableOf(page), 'Alice'))).tokens).toBe(aliceInResearch.tokens)
      expect((await cellsOf(rowOf(memberTableOf(page), 'Bob'))).tokens).toBe(bobInResearch.tokens)
      const workspaceTotal = await cellsOf(rowOf(memberTableOf(page), 'Total'))
      expect(workspaceTotal.tokens).toBe(research.tokens)
      expect(workspaceTotal.calls).toBe(research.calls)
    })

    test('As a member who can view costs, I see an earlier month’s usage only when I pick that month, in both views', {
      tag: ['@spec-13'],
    }, async ({ page, workerStack }) => {
      await workerStack.database.$client`
    insert into usage_entries (workspace_id, month, chat_id, user_id, tokens, cost_micros, calls)
    values ('workspace-acme', ${earlierMonth}, 'chat-research', 'member-alice', 4321, 70000, 3)`
      await workerStack.database.$client`
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens, output_tokens, cost_micros, status, called_at)
    select 'workspace-acme', 'earlier-' || n, 'chat-research', 'member-alice', 'member-alice', 'fake-model', 'fake',
      case when n = 1 then 4000 else 100 end, case when n = 1 then 121 else 0 end, case when n = 1 then 50000 else 10000 end,
      'success', ${`${earlierMonth}-15T12:00:00Z`}::timestamptz
    from generate_series(1, 3) n`

      await openUsageTab(page, 'Research')
      const usageTable = tabPanelOf(page).getByRole('table')
      await expect(monthPickerOf(tabPanelOf(page))).toHaveValue(currentMonth)
      await expect(rowOf(usageTable, 'Total')).not.toContainText('4,321')
      await monthPickerOf(tabPanelOf(page)).selectOption(earlierMonth)
      await expect(rowOf(usageTable, 'Alice')).toContainText('4,321')
      await expect(rowOf(usageTable, 'Alice')).toContainText('$0.07')
      await expect(rowOf(usageTable, 'Alice').getByRole('cell').nth(2)).toHaveText('3')

      await openUsageSettings(page)
      await expect(usageSectionOf(page).getByText('No usage in this period')).toBeVisible()
      await periodPickerOf(page).selectOption('last_month')
      await expect(rowOf(projectTableOf(page), 'No project')).toContainText('4,321')
      await expect(rowOf(memberTableOf(page), 'Alice')).toContainText('4,321')
      await expect(rowOf(memberTableOf(page), 'Total')).toContainText('$0.07')
      await expect(projectTableOf(page)).not.toContainText('15,500')
    })

    test.describe(() => {
      test.use({ signedInAs: 'member-bob' })

      test('As a member without the costs permission, I have no Usage in settings but see every prompter in a chat’s Usage tab', {
        tag: ['@spec-13'],
      }, async ({ page }) => {
        await page.goto('/w/workspace-acme/settings/costs')
        await expect(mainOf(page).getByText('Your workspace role does not give access to this page')).toBeVisible()
        await expect(usageSectionOf(page)).toHaveCount(0)

        await openUsageTab(page, 'Invoice bug')
        const usageTable = tabPanelOf(page).getByRole('table')
        await expect(rowOf(usageTable, 'Alice')).toContainText('12,400')
        await expect(rowOf(usageTable, 'Bob')).toContainText('3,100')
        await expect(rowOf(usageTable, 'Total')).toContainText('15,500')
      })
    })
  })
})
