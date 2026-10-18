import {
  composerOf,
  expect,
  expectMembers,
  mainOf,
  messageContaining,
  openChat,
  openPanelTab,
  type Page,
  panelOf,
  sendMessage,
  sidebarOf,
  panelTabOf as tabOf,
  tabPanelOf,
  test,
} from './fixtures'
import { openPageAs } from './stack'

const tabListOf = (page: Page) => panelOf(page).getByRole('tablist', { name: 'Panel tabs' })
const panelWidthOf = async (page: Page) => (await panelOf(page).boundingBox())!.width

const dragResizeHandleBy = async (page: Page, horizontalOffset: number) => {
  const handleBox = (await page.getByRole('separator', { name: 'Resize panel' }).boundingBox())!
  const handleCenterX = handleBox.x + handleBox.width / 2
  const handleCenterY = handleBox.y + handleBox.height / 2
  await page.mouse.move(handleCenterX, handleCenterY)
  await page.mouse.down()
  await page.mouse.move(handleCenterX + horizontalOffset, handleCenterY, { steps: 8 })
  await page.mouse.up()
}

const tabLabelsOf = (page: Page) =>
  tabListOf(page)
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label')))
const isTabListScrollable = (page: Page) =>
  tabListOf(page).evaluate((element) => element.scrollWidth > element.clientWidth)

const runtimeTabNames = [
  'Files',
  'Changes',
  'Terminal',
  'Plan',
  'Commits',
  'Browser',
  'Usage',
  'Connected tools',
  'Members',
]
const channelTabNames = ['Browser', 'Sources', 'Usage', 'Connected tools', 'Members']

const expectOwnerConnections = async (page: Page) => {
  await expect(tabPanelOf(page).getByRole('heading', { name: 'Connected tools' })).toBeVisible()
  await expect(tabPanelOf(page)).not.toContainText('Connections of')
  const workspaceGroup = tabPanelOf(page).getByRole('region', { name: 'Workspace' })
  await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'CRM' })).toContainText('lookup, update')
  const personalGroup = tabPanelOf(page).getByRole('region', { name: 'Personal' })
  await expect(personalGroup.getByRole('listitem').filter({ hasText: 'GitHub' })).toContainText('Connected')
  await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected')
  await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Notion' })).toContainText('Needs reconnection')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('shows every tab of the Invoice bug runtime panel', async ({ page }) => {
  await test.step('shows the runtime tabs in order with the first selected', async () => {
    await openChat(page, 'Invoice bug')
    expect(await tabLabelsOf(page)).toEqual(runtimeTabNames)
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('shows icon-only tabs without visible text', async () => {
    await expect(tabListOf(page).getByRole('tab')).toHaveCount(runtimeTabNames.length)
    for (const tabName of runtimeTabNames) {
      await expect(tabOf(page, tabName)).toHaveText('')
      await expect(tabOf(page, tabName).locator('svg')).toBeVisible()
    }
  })

  await test.step('fits all runtime tabs at the default width without scrolling', async () => {
    expect(await isTabListScrollable(page)).toBe(false)
  })

  await test.step('spans the full height of the window, flush with the right edge', async () => {
    const viewport = page.viewportSize()!
    const panelBox = (await panelOf(page).boundingBox())!
    expect(panelBox.y).toBeLessThan(2)
    expect(panelBox.y + panelBox.height).toBeGreaterThan(viewport.height - 2)
    expect(panelBox.x + panelBox.width).toBeGreaterThan(viewport.width - 2)
  })

  await test.step('keeps the chat header in the chat column, beside the panel', async () => {
    const panelBox = (await panelOf(page).boundingBox())!
    const titleBox = (await mainOf(page).getByRole('heading', { level: 1 }).boundingBox())!
    const toggleBox = (await page.getByRole('button', { name: 'Hide panel' }).boundingBox())!
    expect(titleBox.x + titleBox.width).toBeLessThan(panelBox.x)
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(panelBox.x)
  })

  await test.step('files: shows the tree and expands and collapses a folder', async () => {
    const billingFolder = tabPanelOf(page).getByRole('button', { name: 'billing' })
    await expect(billingFolder).toHaveAttribute('aria-expanded', 'false')
    await expect(tabPanelOf(page).getByText('tests', { exact: true })).toBeVisible()
    await expect(tabPanelOf(page).getByText('package.json')).toBeVisible()
    await expect(tabPanelOf(page).getByText('tax.ts')).toBeHidden()
    await billingFolder.click()
    await expect(billingFolder).toHaveAttribute('aria-expanded', 'true')
    await expect(tabPanelOf(page).getByText('invoice.ts', { exact: true })).toBeVisible()
    await expect(tabPanelOf(page).getByText('tax.ts')).toBeVisible()
    await billingFolder.click()
    await expect(tabPanelOf(page).getByText('tax.ts')).toBeHidden()
  })

  await test.step('explains each tab in a tooltip on hover', async () => {
    await tabOf(page, 'Commits').hover()
    await expect(page.getByRole('tooltip', { name: 'Commits' })).toBeVisible()
  })

  await test.step('selects a tab on click and shows its content', async () => {
    await tabOf(page, 'Plan').click()
    await expect(tabOf(page, 'Plan')).toHaveAttribute('aria-selected', 'true')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'false')
    await expect(tabPanelOf(page)).toContainText('Reproduce the bug')
  })

  await test.step('plan: lists the steps with their status', async () => {
    const steps = tabPanelOf(page).getByRole('listitem')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toContainText('Reproduce the bug')
    await expect(steps.nth(0)).toContainText('Done')
    await expect(steps.nth(1)).toContainText('Fix the tax calculation')
    await expect(steps.nth(1)).toContainText('In progress')
    await expect(steps.nth(2)).toContainText('Add a regression test')
    await expect(steps.nth(2)).toContainText('To do')
  })

  await test.step('changes: lists the changed files with their counts', async () => {
    await openPanelTab(page, 'Invoice bug', 'Changes')
    const taxChange = tabPanelOf(page).getByRole('button', { name: /billing\/tax\.ts/ })
    await expect(taxChange).toContainText('+3')
    await expect(taxChange).toContainText(/[−-]5/)
    const testChange = tabPanelOf(page).getByRole('button', { name: /tests\/invoice\.test\.ts/ })
    await expect(testChange).toContainText('+12')
    await expect(testChange).toContainText(/[−-]0/)
  })

  await test.step('changes: shows the diff of the selected file', async () => {
    await tabPanelOf(page)
      .getByRole('button', { name: /billing\/tax\.ts/ })
      .click()
    const diffOf = tabPanelOf(page).getByRole('region', { name: 'Diff' })
    await expect(diffOf).toContainText('const total = applyTax(applyTax(net))')
    await expect(diffOf).toContainText('const total = applyTax(net)')
    const diffText = (await diffOf.textContent()) ?? ''
    expect(diffText.indexOf('applyTax(applyTax(net))')).toBeLessThan(
      diffText.lastIndexOf('const total = applyTax(net)'),
    )
  })

  await test.step('terminal: shows the output without any input', async () => {
    await openPanelTab(page, 'Invoice bug', 'Terminal')
    await expect(tabPanelOf(page)).toContainText('$ bun test')
    await expect(tabPanelOf(page)).toContainText('3 pass')
    await expect(tabPanelOf(page)).toContainText('0 fail')
    await expect(panelOf(page).getByRole('textbox')).toHaveCount(0)
  })

  await test.step('commits: lists the commit with its author and time', async () => {
    await openPanelTab(page, 'Invoice bug', 'Commits')
    const commits = tabPanelOf(page).getByRole('listitem')
    await expect(commits).toHaveCount(1)
    await expect(commits.nth(0)).toContainText('a1b2c3d')
    await expect(commits.nth(0)).toContainText('Fix tax applied twice')
    await expect(commits.nth(0)).toContainText('Alice')
    await expect(commits.nth(0)).toContainText('11:20')
  })

  await test.step('usage: shows one row per member and a total on a runtime chat', async () => {
    await openPanelTab(page, 'Invoice bug', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('12,400')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.18')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('3,100')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('$0.05')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('15,500')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.23')
  })

  await test.step('browser: shows the page of a runtime chat', async () => {
    await openPanelTab(page, 'Invoice bug', 'Browser')
    await expect(tabPanelOf(page)).toContainText('http://localhost:3000/invoices')
    await expect(tabPanelOf(page)).toContainText('Invoices')
    await expect(tabPanelOf(page)).toContainText('Invoice total: 120.00')
  })

  await test.step('lists the workspace and personal connections of the owner on Invoice bug', async () => {
    await openPanelTab(page, 'Invoice bug', 'Connected tools')
    await expectOwnerConnections(page)
  })

  await test.step('28-6. lists the members with their role rows on Invoice bug, the owner first', async () => {
    await openPanelTab(page, 'Invoice bug', 'Members')
    await expectMembers(page, [
      ['Alice', 'Owner'],
      ['Lee', 'Reader'],
      ['Bob', 'Prompter'],
    ])
  })
})

test('shows every tab of the Welcome channel panel', async ({ page }) => {
  await test.step('shows the channel tabs in order with the first selected', async () => {
    await openChat(page, 'Welcome')
    expect(await tabLabelsOf(page)).toEqual(channelTabNames)
    await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('browser: shows the page of a channel', async () => {
    await expect(tabPanelOf(page)).toContainText('https://example.com/onboarding')
    await expect(tabPanelOf(page)).toContainText('Onboarding guide')
    await expect(tabPanelOf(page)).toContainText('Welcome to the team.')
  })

  await test.step('sources: lists the sources with their origin', async () => {
    await openPanelTab(page, 'Welcome', 'Sources')
    const sources = tabPanelOf(page).getByRole('listitem')
    await expect(sources).toHaveCount(2)
    await expect(sources.nth(0)).toContainText('Employee handbook')
    await expect(sources.nth(0)).toContainText('Onyx')
    await expect(sources.nth(1)).toContainText('Onboarding wiki page')
    await expect(sources.nth(1)).toContainText('Wiki')
  })

  await test.step('usage: shows zeros for every member on a channel', async () => {
    await openPanelTab(page, 'Welcome', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.00')
  })

  await test.step('lists the workspace and personal connections of the owner on Welcome', async () => {
    await openPanelTab(page, 'Welcome', 'Connected tools')
    await expectOwnerConnections(page)
  })

  await test.step('lists the members with their role on Welcome', async () => {
    await openPanelTab(page, 'Welcome', 'Members')
    await expectMembers(page, [
      ['Alice', 'Owner'],
      ['Bob', 'Prompter'],
    ])
  })
})

test('shows the empty states and the panel of another owner', async ({ page }) => {
  await test.step('has no panel when no chat is selected', async () => {
    await expect(panelOf(page)).toHaveCount(0)
  })

  await test.step('shows the empty state of each runtime tab without data', async () => {
    await openChat(page, 'Research')
    await expect(tabPanelOf(page)).toContainText('No files')
    for (const [tabName, emptyText] of [
      ['Changes', 'No changes'],
      ['Terminal', 'No terminal output'],
      ['Plan', 'No plan'],
      ['Commits', 'No commits'],
    ] as const) {
      await tabOf(page, tabName).click()
      await expect(tabOf(page, tabName)).toHaveAttribute('aria-selected', 'true')
      await expect(tabPanelOf(page)).toContainText(emptyText)
    }
  })

  await test.step('usage: shows zeros for the owner of a chat without data', async () => {
    await openPanelTab(page, 'Research', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.00')
  })

  await test.step('lists only the owner of a chat without explicit members', async () => {
    await openPanelTab(page, 'Research', 'Members')
    const members = tabPanelOf(page).getByRole('listitem')
    await expect(members).toHaveCount(1)
    await expect(members.nth(0)).toContainText('Alice')
    await expect(members.nth(0)).toContainText('Owner')
  })

  await test.step('browser: shows an empty state without data', async () => {
    await openChat(page, 'Standup')
    await expect(tabPanelOf(page)).toContainText('No page open')
  })

  await test.step('sources: shows an empty state without data', async () => {
    await openPanelTab(page, 'Standup', 'Sources')
    await expect(tabPanelOf(page)).toContainText('No sources')
  })

  await test.step('shows the shared connections and an empty message for an owner without personal connections', async () => {
    await openPanelTab(page, 'Setup helper', 'Connected tools')
    await expect(tabPanelOf(page).getByRole('heading', { name: 'Connected tools' })).toBeVisible()
    const workspaceGroup = tabPanelOf(page).getByRole('region', { name: 'Workspace' })
    await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'CRM' })).toContainText('lookup, update')
    await expect(tabPanelOf(page).getByRole('region', { name: 'Personal' })).toContainText('No personal connections')
  })
})

test('navigates the tabs with the keyboard', async ({ page }) => {
  await openChat(page, 'Invoice bug')

  await test.step('moves between tabs with the arrow keys, wrapping at both ends, with a tooltip on keyboard focus', async () => {
    await tabOf(page, 'Files').focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabOf(page, 'Changes')).toBeFocused()
    await expect(tabOf(page, 'Changes')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tooltip', { name: 'Changes' })).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(tabOf(page, 'Files')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(tabOf(page, 'Members')).toBeFocused()
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(tabOf(page, 'Files')).toBeFocused()
  })

  await test.step('jumps to the first and last tab with Home and End', async () => {
    await tabOf(page, 'Plan').focus()
    await page.keyboard.press('End')
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Home')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('selects the first tab again when another chat is opened', async () => {
    await openPanelTab(page, 'Invoice bug', 'Plan')
    await openChat(page, 'Welcome')
    await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
    await openChat(page, 'Invoice bug')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })
})

test('hides and shows the panel', async ({ page }) => {
  await openPanelTab(page, 'Invoice bug', 'Plan')
  await dragResizeHandleBy(page, -100)
  const widthBeforeHiding = await panelWidthOf(page)

  await test.step('hides the panel and gives the width and the full height back to the chat view', async () => {
    const composerWidthWithPanel = (await composerOf(page).boundingBox())!.width
    await page.getByRole('button', { name: 'Hide panel' }).click()
    await expect(panelOf(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show panel' })).toBeVisible()
    const composerBox = (await composerOf(page).boundingBox())!
    expect(composerBox.width).toBeGreaterThan(composerWidthWithPanel + 200)
    expect(composerBox.x + composerBox.width).toBeGreaterThan(page.viewportSize()!.width - 96)
  })

  await test.step('restores the previous width and tab when shown again', async () => {
    await page.getByRole('button', { name: 'Show panel' }).click()
    await expect(panelOf(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide panel' })).toBeVisible()
    expect(await panelWidthOf(page)).toBeCloseTo(widthBeforeHiding, 0)
    await expect(tabOf(page, 'Plan')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('keeps the panel hidden when switching chats', async () => {
    await page.getByRole('button', { name: 'Hide panel' }).click()
    await openChat(page, 'Welcome')
    await expect(panelOf(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show panel' })).toBeVisible()
  })
})

test('resizes the panel within its bounds', async ({ page }) => {
  await openChat(page, 'Invoice bug')
  const separator = page.getByRole('separator', { name: 'Resize panel' })

  await test.step('exposes the separator with its bounds and the default width', async () => {
    await expect(separator).toHaveAttribute('aria-valuemin', '280')
    await expect(separator).toHaveAttribute('aria-valuemax', '640')
    await expect(separator).toHaveAttribute('aria-valuenow', '360')
    expect(await panelWidthOf(page)).toBeCloseTo(360, 0)
  })

  await test.step('changes the width by 16px with the arrow keys', async () => {
    await separator.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(separator).toHaveAttribute('aria-valuenow', '376')
    expect(await panelWidthOf(page)).toBeCloseTo(376, 0)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '344')
    expect(await panelWidthOf(page)).toBeCloseTo(344, 0)
  })

  await test.step('widens when dragged left and narrows when dragged right', async () => {
    const startWidth = await panelWidthOf(page)
    await dragResizeHandleBy(page, -100)
    expect(await panelWidthOf(page)).toBeCloseTo(startWidth + 100, 0)
    await dragResizeHandleBy(page, 50)
    expect(await panelWidthOf(page)).toBeCloseTo(startWidth + 50, 0)
  })

  await test.step('keeps the width when switching chats', async () => {
    const widthAfterResize = await panelWidthOf(page)
    await openChat(page, 'Welcome')
    expect(await panelWidthOf(page)).toBeCloseTo(widthAfterResize, 0)
    await openChat(page, 'Invoice bug')
  })

  await test.step('stays between 280px and 640px', async () => {
    await dragResizeHandleBy(page, -1000)
    expect(await panelWidthOf(page)).toBeCloseTo(640, 0)
    await dragResizeHandleBy(page, 1000)
    expect(await panelWidthOf(page)).toBeCloseTo(280, 0)
  })

  await test.step('scrolls the tab list horizontally when the panel is narrow and keeps the selected tab visible', async () => {
    const overflowX = await tabListOf(page).evaluate((element) => getComputedStyle(element).overflowX)
    expect(['auto', 'scroll']).toContain(overflowX)
    expect(await isTabListScrollable(page)).toBe(true)
    await tabOf(page, 'Files').focus()
    await page.keyboard.press('End')
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
    await expect(tabOf(page, 'Members')).toBeInViewport()
  })
})

test('themes the panel in light and dark mode', async ({ page }) => {
  await openChat(page, 'Invoice bug')
  const styleSignatureOf = (tabName: string) =>
    tabOf(page, tabName).evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.color, style.backgroundColor, style.fontWeight, style.borderBottomColor, style.boxShadow].join('|')
    })

  for (const colorScheme of ['light', 'dark'] as const)
    await test.step(`distinguishes the selected tab in ${colorScheme} mode`, async () => {
      await page.emulateMedia({ colorScheme })
      expect(await styleSignatureOf('Files')).not.toBe(await styleSignatureOf('Changes'))
    })

  await test.step('uses the app text color for the panel content in dark mode', async () => {
    await openPanelTab(page, 'Invoice bug', 'Members')
    const panelContentColor = await tabPanelOf(page).evaluate((element) => getComputedStyle(element).color)
    const pageTitleColor = await mainOf(page)
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).color)
    expect(panelContentColor).toBe(pageTitleColor)
  })
})

test('28-4. a member who is not a participant reads the public Welcome channel, and joining it makes him a Prompter who posts', async ({
  browser,
  workerStack,
}) => {
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await sidebarOf(leePage)
    .getByRole('button', { name: /^Browse channels/ })
    .click()
  await leePage
    .getByRole('dialog', { name: 'Browse channels' })
    .getByRole('link', { name: /Welcome/ })
    .click()
  await tabOf(leePage, 'Members').click()
  await expect(messageContaining(leePage, 'Welcome to the team!')).toHaveCount(1)
  await expectMembers(leePage, [
    ['Alice', 'Owner'],
    ['Bob', 'Prompter'],
  ])
  await mainOf(leePage).getByRole('button', { name: 'Join channel' }).click()
  await sendMessage(leePage, 'Lee says hello')
  await expect(messageContaining(leePage, 'Lee says hello')).toHaveCount(1)
  await expectMembers(leePage, [
    ['Alice', 'Owner'],
    ['Lee', 'Prompter'],
    ['Bob', 'Prompter'],
  ])
  await leePage.context().close()
})
