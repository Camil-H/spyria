import {
  expect,
  messageContaining,
  newRuntimeChat,
  panelOf,
  panelTabOf,
  sendMessage,
  tabPanelOf,
  test,
  workingIndicatorOf,
} from './fixtures'

const report = '<!doctype html><title>Totals</title><h1>Invoice totals</h1><p>120.00</p>'

test.describe('Browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a prompter, I see the address of the report the agent opens in the Browser tab, load it, go back to the pages it opened, and search the web from the address bar', {
    tag: ['@spec-10', '@spec-25'],
  }, async ({ page, agentScript }) => {
    const chatId = await newRuntimeChat(page, 'Totals report')
    await agentScript(chatId, {
      steps: [
        { edit: { path: 'reports/totals.html', create: report } },
        { tool: 'mcp__spyria__open_page', arguments: { address: 'reports/totals.html', title: 'Invoice totals' } },
      ],
      text: 'The report is open.',
    })
    await panelTabOf(page, 'Browser').click()
    await expect(tabPanelOf(page)).toContainText('No page open')
    await sendMessage(page, 'Build the totals report')
    await expect(messageContaining(page, 'The report is open.')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    const loadPage = tabPanelOf(page).getByRole('button', { name: 'Load page' })
    const reportFrame = tabPanelOf(page).frameLocator('iframe[title="reports/totals.html"]')
    await expect(loadPage).toBeVisible()
    await expect(tabPanelOf(page)).toContainText('The agent opened this page')
    await expect(tabPanelOf(page).locator('iframe')).toHaveCount(0)
    await expect(tabPanelOf(page).getByRole('searchbox', { name: 'Search or type an address' })).toHaveValue(
      'reports/totals.html',
    )
    await loadPage.click()
    await expect(reportFrame.getByRole('heading', { name: 'Invoice totals' })).toBeVisible()
    await tabPanelOf(page).getByRole('button', { name: 'All pages' }).click()
    const opened = tabPanelOf(page).getByRole('list', { name: 'Pages the agent opened' })
    await expect(opened.getByRole('listitem')).toHaveText(['reports/totals.htmlInvoice totals'])

    await page.route('https://www.bing.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Results for zero sync</h1>' }),
    )
    const address = tabPanelOf(page).getByRole('searchbox', { name: 'Search or type an address' })
    await address.fill('zero sync')
    await address.press('Enter')
    const results = tabPanelOf(page).frameLocator('iframe[title="https://www.bing.com/search?q=zero%20sync"]')
    await expect(results.getByRole('heading', { name: 'Results for zero sync' })).toBeVisible()
    await expect(panelOf(page).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
      'href',
      'https://www.bing.com/search?q=zero%20sync',
    )
    await tabPanelOf(page).getByRole('button', { name: 'All pages' }).click()
    await opened.getByRole('button', { name: /^reports\/totals\.html/ }).click()
    await loadPage.click()
    await expect(reportFrame.getByRole('heading', { name: 'Invoice totals' })).toBeVisible()
    await expect(panelOf(page).getByRole('link', { name: 'Open in a new tab' })).toHaveCount(0)
  })
})
