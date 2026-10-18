import { seedSpend } from '@hq/db/testing'
import { expect, type Locator, mainOf, openProfile, openSettings, type Page, test } from './fixtures'

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

test('1. Analyze costs this month by day: the chart and the member, project, chat and model tables match the seed; by model restacks the chart', async ({
  page,
}) => {
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

test('2. the decomposition shows six factors against last month and highlights tokens per request, which doubled', async ({
  page,
}) => {
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
  for (const [name, cells] of expectedFactors) expect(await cellTextsOf(rowOf(decomposition, name))).toEqual([...cells])
  const biggestMover = decomposition.locator('tr[aria-current="true"]')
  await expect(biggestMover).toHaveCount(1)
  await expect(biggestMover.getByRole('rowheader')).toHaveText('Tokens per request · Biggest mover')
  await expect(usageSectionOf(page, 'Spend decomposition')).toContainText(
    'Spend $0.08 against $0.04 in the previous period (+100%)',
  )
})

test('3. cost per merged PR lists the merged PR with its chat’s cost', async ({ page }) => {
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

test.describe('4. as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('Bob’s Profile shows only his usage, per chat and per model, with his decomposition', async ({ page }) => {
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
