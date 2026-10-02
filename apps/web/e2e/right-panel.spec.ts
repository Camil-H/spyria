import { expect, type Page, test } from '@playwright/test'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const mainOf = (page: Page) => page.getByRole('main')
const panelOf = (page: Page) => page.getByRole('region', { name: 'Side panel' })
const tabListOf = (page: Page) => panelOf(page).getByRole('tablist', { name: 'Panel tabs' })
const tabOf = (page: Page, tabName: string) => tabListOf(page).getByRole('tab', { name: tabName, exact: true })
const tabPanelOf = (page: Page) => panelOf(page).getByRole('tabpanel')
const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })

const openChat = async (page: Page, chatName: string) => {
  await sidebarOf(page).getByRole('link', { name: chatName }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

const openTab = async (page: Page, chatName: string, tabName: string) => {
  await openChat(page, chatName)
  await tabOf(page, tabName).click()
  await expect(tabOf(page, tabName)).toHaveAttribute('aria-selected', 'true')
}

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

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. tabs by chat type', () => {
  test('shows the runtime tabs in order with the first selected', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    expect(await tabLabelsOf(page)).toEqual(runtimeTabNames)
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })

  test('shows the channel tabs in order with the first selected', async ({ page }) => {
    await openChat(page, 'Welcome')
    expect(await tabLabelsOf(page)).toEqual(channelTabNames)
    await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
  })

  test('shows icon-only tabs without visible text', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await expect(tabListOf(page).getByRole('tab')).toHaveCount(runtimeTabNames.length)
    for (const tabName of runtimeTabNames) {
      await expect(tabOf(page, tabName)).toHaveText('')
      await expect(tabOf(page, tabName).locator('svg')).toBeVisible()
    }
  })

  test('explains each tab in a tooltip on hover and on keyboard focus', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await tabOf(page, 'Commits').hover()
    await expect(page.getByRole('tooltip', { name: 'Commits' })).toBeVisible()

    await tabOf(page, 'Files').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tooltip', { name: 'Changes' })).toBeVisible()
  })

  test('has no panel when no chat is selected', async ({ page }) => {
    await expect(panelOf(page)).toHaveCount(0)
  })
})

test.describe('2. tab navigation', () => {
  test('selects a tab on click and shows its content', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await tabOf(page, 'Plan').click()
    await expect(tabOf(page, 'Plan')).toHaveAttribute('aria-selected', 'true')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'false')
    await expect(tabPanelOf(page)).toContainText('Reproduce the bug')
  })

  test('moves between tabs with the arrow keys, wrapping at both ends', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await tabOf(page, 'Files').focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabOf(page, 'Changes')).toBeFocused()
    await expect(tabOf(page, 'Changes')).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(tabOf(page, 'Members')).toBeFocused()
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowRight')
    await expect(tabOf(page, 'Files')).toBeFocused()
  })

  test('jumps to the first and last tab with Home and End', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await tabOf(page, 'Plan').focus()
    await page.keyboard.press('End')
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Home')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })

  test('selects the first tab again when another chat is opened', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Plan')
    await openChat(page, 'Welcome')
    await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
    await openChat(page, 'Invoice bug')
    await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('2b. tab overflow', () => {
  test('fits all runtime tabs at the default width without scrolling', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const isScrollable = await tabListOf(page).evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(isScrollable).toBe(false)
  })

  test('scrolls the tab list horizontally when the panel is narrow and keeps the selected tab visible', async ({
    page,
  }) => {
    await openChat(page, 'Invoice bug')
    await dragResizeHandleBy(page, 1000)
    expect(await panelWidthOf(page)).toBeCloseTo(280, 0)

    const overflowX = await tabListOf(page).evaluate((element) => getComputedStyle(element).overflowX)
    expect(['auto', 'scroll']).toContain(overflowX)
    const isScrollable = await tabListOf(page).evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(isScrollable).toBe(true)

    await tabOf(page, 'Files').focus()
    await page.keyboard.press('End')
    await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
    await expect(tabOf(page, 'Members')).toBeInViewport()
  })
})

test.describe('3. files', () => {
  test('shows the tree and expands and collapses a folder', async ({ page }) => {
    await openChat(page, 'Invoice bug')
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

  test('shows an empty state without data', async ({ page }) => {
    await openChat(page, 'Research')
    await expect(tabPanelOf(page)).toContainText('No files')
  })
})

test.describe('4. changes', () => {
  test('lists the changed files with their counts', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Changes')
    const taxChange = tabPanelOf(page).getByRole('button', { name: /billing\/tax\.ts/ })
    await expect(taxChange).toContainText('+3')
    await expect(taxChange).toContainText(/[−-]5/)
    const testChange = tabPanelOf(page).getByRole('button', { name: /tests\/invoice\.test\.ts/ })
    await expect(testChange).toContainText('+12')
    await expect(testChange).toContainText(/[−-]0/)
  })

  test('shows the diff of the selected file', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Changes')
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

  test('shows an empty state without data', async ({ page }) => {
    await openTab(page, 'Research', 'Changes')
    await expect(tabPanelOf(page)).toContainText('No changes')
  })
})

test.describe('5. terminal', () => {
  test('shows the output without any input', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Terminal')
    await expect(tabPanelOf(page)).toContainText('$ bun test')
    await expect(tabPanelOf(page)).toContainText('3 pass')
    await expect(tabPanelOf(page)).toContainText('0 fail')
    await expect(panelOf(page).getByRole('textbox')).toHaveCount(0)
  })

  test('shows an empty state without data', async ({ page }) => {
    await openTab(page, 'Research', 'Terminal')
    await expect(tabPanelOf(page)).toContainText('No terminal output')
  })
})

test.describe('6. plan', () => {
  test('lists the steps with their status', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Plan')
    const steps = tabPanelOf(page).getByRole('listitem')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toContainText('Reproduce the bug')
    await expect(steps.nth(0)).toContainText('Done')
    await expect(steps.nth(1)).toContainText('Fix the tax calculation')
    await expect(steps.nth(1)).toContainText('In progress')
    await expect(steps.nth(2)).toContainText('Add a regression test')
    await expect(steps.nth(2)).toContainText('To do')
  })

  test('shows an empty state without data', async ({ page }) => {
    await openTab(page, 'Research', 'Plan')
    await expect(tabPanelOf(page)).toContainText('No plan')
  })
})

test.describe('7. commits', () => {
  test('lists the commit with its author and time', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Commits')
    const commits = tabPanelOf(page).getByRole('listitem')
    await expect(commits).toHaveCount(1)
    await expect(commits.nth(0)).toContainText('a1b2c3d')
    await expect(commits.nth(0)).toContainText('Fix tax applied twice')
    await expect(commits.nth(0)).toContainText('Alice')
    await expect(commits.nth(0)).toContainText('11:20')
  })

  test('shows an empty state without data', async ({ page }) => {
    await openTab(page, 'Research', 'Commits')
    await expect(tabPanelOf(page)).toContainText('No commits')
  })
})

test.describe('8. usage', () => {
  test('shows one row per member and a total on a runtime chat', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('12,400')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.18')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('3,100')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('$0.05')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('15,500')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.23')
  })

  test('shows zeros for every member on a channel', async ({ page }) => {
    await openTab(page, 'Welcome', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Bob/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.00')
  })

  test('shows zeros for the owner of a chat without data', async ({ page }) => {
    await openTab(page, 'Research', 'Usage')
    const usageTable = tabPanelOf(page).getByRole('table')
    await expect(usageTable.getByRole('row', { name: /Alice/ })).toContainText('$0.00')
    await expect(usageTable.getByRole('row', { name: /Total/ })).toContainText('$0.00')
  })
})

test.describe('9. browser', () => {
  test('shows the page of a channel', async ({ page }) => {
    await openChat(page, 'Welcome')
    await expect(tabPanelOf(page)).toContainText('https://example.com/onboarding')
    await expect(tabPanelOf(page)).toContainText('Onboarding guide')
    await expect(tabPanelOf(page)).toContainText('Welcome to the team.')
  })

  test('shows the page of a runtime chat', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Browser')
    await expect(tabPanelOf(page)).toContainText('http://localhost:3000/invoices')
    await expect(tabPanelOf(page)).toContainText('Invoices')
    await expect(tabPanelOf(page)).toContainText('Invoice total: 120.00')
  })

  test('shows an empty state without data', async ({ page }) => {
    await openChat(page, 'Standup')
    await expect(tabPanelOf(page)).toContainText('No page open')
  })
})

test.describe('10. sources', () => {
  test('lists the sources with their origin', async ({ page }) => {
    await openTab(page, 'Welcome', 'Sources')
    const sources = tabPanelOf(page).getByRole('listitem')
    await expect(sources).toHaveCount(2)
    await expect(sources.nth(0)).toContainText('Employee handbook')
    await expect(sources.nth(0)).toContainText('Onyx')
    await expect(sources.nth(1)).toContainText('Onboarding wiki page')
    await expect(sources.nth(1)).toContainText('Wiki')
  })

  test('shows an empty state without data', async ({ page }) => {
    await openTab(page, 'Standup', 'Sources')
    await expect(tabPanelOf(page)).toContainText('No sources')
  })
})

test.describe('11. connected tools', () => {
  for (const chatName of ['Welcome', 'Invoice bug']) {
    test(`lists the workspace and personal connections of the owner on ${chatName}`, async ({ page }) => {
      await openTab(page, chatName, 'Connected tools')
      await expect(tabPanelOf(page).getByRole('heading', { name: 'Connected tools' })).toBeVisible()
      await expect(tabPanelOf(page)).not.toContainText('Connections of')

      const workspaceGroup = tabPanelOf(page).getByRole('region', { name: 'Workspace' })
      await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('2 of 5 tables')
      await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Onyx' })).toContainText('All sources')

      const personalGroup = tabPanelOf(page).getByRole('region', { name: 'Personal' })
      await expect(personalGroup.getByRole('listitem').filter({ hasText: 'GitHub' })).toContainText('Connected')
      await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected')
      await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Notion' })).toContainText(
        'Needs reconnection',
      )
    })
  }

  test('shows the shared connections and an empty message for an owner without personal connections', async ({
    page,
  }) => {
    await openTab(page, 'Setup helper', 'Connected tools')
    await expect(tabPanelOf(page).getByRole('heading', { name: 'Connected tools' })).toBeVisible()
    const workspaceGroup = tabPanelOf(page).getByRole('region', { name: 'Workspace' })
    await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('1 of 5 tables')
    await expect(tabPanelOf(page).getByRole('region', { name: 'Personal' })).toContainText('No personal connections')
  })
})

test.describe('12. members', () => {
  for (const chatName of ['Invoice bug', 'Welcome']) {
    test(`lists the members with their role on ${chatName}`, async ({ page }) => {
      await openTab(page, chatName, 'Members')
      const members = tabPanelOf(page).getByRole('listitem')
      await expect(members).toHaveCount(2)
      await expect(members.filter({ hasText: 'Alice' })).toContainText('Owner')
      await expect(members.filter({ hasText: 'Bob' })).toContainText('Can prompt')
    })
  }

  test('lists only the owner of a chat without explicit members', async ({ page }) => {
    await openTab(page, 'Research', 'Members')
    const members = tabPanelOf(page).getByRole('listitem')
    await expect(members).toHaveCount(1)
    await expect(members.nth(0)).toContainText('Alice')
    await expect(members.nth(0)).toContainText('Owner')
  })
})

test.describe('13. collapse', () => {
  test('hides and shows the panel and gives the width back to the chat view', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const composerWidthWithPanel = (await composerOf(page).boundingBox())!.width

    await page.getByRole('button', { name: 'Hide panel' }).click()
    await expect(panelOf(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show panel' })).toBeVisible()
    const composerWidthWithoutPanel = (await composerOf(page).boundingBox())!.width
    expect(composerWidthWithoutPanel).toBeGreaterThan(composerWidthWithPanel + 200)

    await page.getByRole('button', { name: 'Show panel' }).click()
    await expect(panelOf(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide panel' })).toBeVisible()
  })

  test('restores the previous width and tab when shown again', async ({ page }) => {
    await openTab(page, 'Invoice bug', 'Plan')
    await dragResizeHandleBy(page, -100)
    const widthBeforeHiding = await panelWidthOf(page)

    await page.getByRole('button', { name: 'Hide panel' }).click()
    await page.getByRole('button', { name: 'Show panel' }).click()

    expect(await panelWidthOf(page)).toBeCloseTo(widthBeforeHiding, 0)
    await expect(tabOf(page, 'Plan')).toHaveAttribute('aria-selected', 'true')
  })

  test('keeps the panel hidden when switching chats', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await page.getByRole('button', { name: 'Hide panel' }).click()
    await openChat(page, 'Welcome')
    await expect(panelOf(page)).toBeHidden()
    await expect(page.getByRole('button', { name: 'Show panel' })).toBeVisible()
  })
})

test.describe('14. resize', () => {
  test('exposes the separator with its bounds and the default width', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const separator = page.getByRole('separator', { name: 'Resize panel' })
    await expect(separator).toHaveAttribute('aria-valuemin', '280')
    await expect(separator).toHaveAttribute('aria-valuemax', '640')
    await expect(separator).toHaveAttribute('aria-valuenow', '360')
    expect(await panelWidthOf(page)).toBeCloseTo(360, 0)
  })

  test('widens when dragged left and narrows when dragged right', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const defaultWidth = await panelWidthOf(page)

    await dragResizeHandleBy(page, -100)
    expect(await panelWidthOf(page)).toBeCloseTo(defaultWidth + 100, 0)

    await dragResizeHandleBy(page, 50)
    expect(await panelWidthOf(page)).toBeCloseTo(defaultWidth + 50, 0)
  })

  test('stays between 280px and 640px', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await dragResizeHandleBy(page, -1000)
    expect(await panelWidthOf(page)).toBeCloseTo(640, 0)
    await dragResizeHandleBy(page, 1000)
    expect(await panelWidthOf(page)).toBeCloseTo(280, 0)
  })

  test('changes the width by 16px with the arrow keys', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const separator = page.getByRole('separator', { name: 'Resize panel' })
    await separator.focus()

    await page.keyboard.press('ArrowLeft')
    await expect(separator).toHaveAttribute('aria-valuenow', '376')
    expect(await panelWidthOf(page)).toBeCloseTo(376, 0)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '344')
    expect(await panelWidthOf(page)).toBeCloseTo(344, 0)
  })

  test('keeps the width when switching chats', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await dragResizeHandleBy(page, -100)
    const widthAfterResize = await panelWidthOf(page)

    await openChat(page, 'Welcome')
    expect(await panelWidthOf(page)).toBeCloseTo(widthAfterResize, 0)
  })
})

test.describe('15. theming', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`distinguishes the selected tab in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await openChat(page, 'Invoice bug')
      const styleSignatureOf = (tabName: string) =>
        tabOf(page, tabName).evaluate((element) => {
          const style = getComputedStyle(element)
          return [style.color, style.backgroundColor, style.fontWeight, style.borderBottomColor, style.boxShadow].join(
            '|',
          )
        })
      expect(await styleSignatureOf('Files')).not.toBe(await styleSignatureOf('Changes'))
    })
  }

  test('uses the app text color for the panel content in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openTab(page, 'Invoice bug', 'Members')
    const panelContentColor = await tabPanelOf(page).evaluate((element) => getComputedStyle(element).color)
    const pageTitleColor = await mainOf(page)
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).color)
    expect(panelContentColor).toBe(pageTitleColor)
  })
})

test.describe('16. full height', () => {
  test('spans the full height of the window, flush with the right edge', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const viewport = page.viewportSize()!
    const panelBox = (await panelOf(page).boundingBox())!
    expect(panelBox.y).toBeLessThan(2)
    expect(panelBox.y + panelBox.height).toBeGreaterThan(viewport.height - 2)
    expect(panelBox.x + panelBox.width).toBeGreaterThan(viewport.width - 2)
  })

  test('keeps the chat header in the chat column, beside the panel', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const panelBox = (await panelOf(page).boundingBox())!
    const titleBox = (await mainOf(page).getByRole('heading', { level: 1 }).boundingBox())!
    const toggleBox = (await page.getByRole('button', { name: 'Hide panel' }).boundingBox())!
    expect(titleBox.x + titleBox.width).toBeLessThan(panelBox.x)
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(panelBox.x)
  })

  test('gives the full height back to the chat view when hidden', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await page.getByRole('button', { name: 'Hide panel' }).click()
    const viewport = page.viewportSize()!
    const composerBox = (await composerOf(page).boundingBox())!
    expect(composerBox.x + composerBox.width).toBeGreaterThan(viewport.width - 96)
  })
})
