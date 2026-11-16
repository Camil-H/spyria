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

  test('As a prompter, I watch my own browser live in the Browser tab, am warned once that what the agent reads can reach the chat, and open the report the agent built from the files it opened', {
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
    await sendMessage(page, 'Build the totals report')
    await expect(messageContaining(page, 'The report is open.')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    await panelTabOf(page, 'Browser').click()
    const reportFrame = tabPanelOf(page).frameLocator('iframe[title="reports/totals.html"]')
    await tabPanelOf(page).getByRole('button', { name: 'Files the agent opened' }).click()
    await tabPanelOf(page).getByRole('list', { name: 'Files the agent opened' }).getByRole('button').click()
    await expect(reportFrame.getByRole('heading', { name: 'Invoice totals' })).toBeVisible()
    await tabPanelOf(page).getByRole('button', { name: 'Back to your browser' }).click()

    const browser = tabPanelOf(page).getByRole('application', { name: 'Your browser' })
    await expect(browser.getByRole('img', { name: 'Example' })).toBeVisible()
    await expect(tabPanelOf(page).getByRole('searchbox', { name: 'Search or type an address' })).toHaveValue(
      'https://example.com/',
    )
    await expect(panelOf(page).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
      'href',
      'https://example.com/',
    )
    const warning = tabPanelOf(page).getByText('what it reads can end up in the chat')
    await expect(warning).toBeVisible()
    await tabPanelOf(page).getByRole('button', { name: 'Got it' }).click()
    await expect(warning).toHaveCount(0)
    await page.reload()
    await panelTabOf(page, 'Browser').click()
    await expect(tabPanelOf(page).getByRole('application', { name: 'Your browser' })).toBeVisible()
    await expect(tabPanelOf(page).getByText('what it reads can end up in the chat')).toHaveCount(0)
  })
})
