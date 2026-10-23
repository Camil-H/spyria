import {
  composerOf,
  expect,
  expectLooks,
  expectMembers,
  mainOf,
  openChat,
  openPanelTab,
  type Page,
  panelOf,
  panelTabOf as tabOf,
  tabPanelOf,
  test,
} from './fixtures'

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

const runtimeTabNames = ['Files', 'Changes', 'Commits', 'Browser', 'Usage', 'Connected tools', 'Members']
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

test.describe('Side panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see every tab of a runtime chat’s panel, icon-only in order, filling the window height beside the chat', async ({
    page,
  }) => {
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

    await test.step('files: shows no files for a chat without a workspace', async () => {
      await expect(tabPanelOf(page)).toContainText('No files')
    })

    await test.step('explains each tab in a tooltip on hover', async () => {
      await tabOf(page, 'Commits').hover()
      await expect(page.getByRole('tooltip', { name: 'Commits' })).toBeVisible()
    })

    await test.step('selects a tab on click and shows its content', async () => {
      await tabOf(page, 'Browser').click()
      await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
      await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'false')
      await expect(tabPanelOf(page)).toContainText('Invoices')
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

    await test.step('lists the members with their role rows on Invoice bug, the owner first', async () => {
      await openPanelTab(page, 'Invoice bug', 'Members')
      await expectMembers(page, [
        ['Alice', 'Owner'],
        ['Bob', 'Prompter'],
        ['Lee', 'Reader'],
      ])
    })
  })

  test('As a member, I see every tab of a channel’s panel', async ({ page }) => {
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

    await expectLooks(page, panelOf(page), 'channel-panel-connected-tools')

    await test.step('lists the members with their role on Welcome', async () => {
      await openPanelTab(page, 'Welcome', 'Members')
      await expectMembers(page, [
        ['Alice', 'Owner'],
        ['Bob', 'Prompter'],
      ])
    })
  })

  test('As a member, I see the panel’s empty states and the panel of a chat another member owns', async ({ page }) => {
    await test.step('has no panel when no chat is selected', async () => {
      await expect(panelOf(page)).toHaveCount(0)
    })

    await test.step('shows the empty state of each runtime tab without data', async () => {
      await openChat(page, 'Research')
      await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
      for (const [tabName, emptyText] of [
        ['Changes', 'No changes'],
        ['Commits', 'No commits'],
      ] as const) {
        await tabOf(page, tabName).click()
        await expect(tabOf(page, tabName)).toHaveAttribute('aria-selected', 'true')
        await expect(tabPanelOf(page).getByRole('heading', { level: 2, name: tabName })).toBeVisible()
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

  test('As a member, I move between the panel tabs with the keyboard', async ({ page }) => {
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
      await tabOf(page, 'Commits').focus()
      await page.keyboard.press('End')
      await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Home')
      await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
    })

    await test.step('selects the first tab again when another chat is opened', async () => {
      await openPanelTab(page, 'Invoice bug', 'Commits')
      await openChat(page, 'Welcome')
      await expect(tabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
      await openChat(page, 'Invoice bug')
      await expect(tabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
    })
  })

  test('As a member, I hide and show the panel, which keeps its width and tab', async ({ page }) => {
    await openPanelTab(page, 'Invoice bug', 'Commits')
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
      await expect(tabOf(page, 'Commits')).toHaveAttribute('aria-selected', 'true')
    })

    await test.step('keeps the panel hidden when switching chats', async () => {
      await page.getByRole('button', { name: 'Hide panel' }).click()
      await openChat(page, 'Welcome')
      await expect(panelOf(page)).toBeHidden()
      await expect(page.getByRole('button', { name: 'Show panel' })).toBeVisible()
    })
  })

  test('As a member, I resize the panel within its bounds, with the mouse or the keyboard', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const separator = page.getByRole('separator', { name: 'Resize panel' })

    await test.step('exposes the separator with its bounds and the default width', async () => {
      await expect(separator).toHaveAttribute('aria-valuemin', '280')
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

    await test.step('stays between 280px and the width that leaves the chat 320px, beyond the former 640px cap', async () => {
      const maximumWidth = Math.floor((await mainOf(page).boundingBox())!.width - 320)
      expect(maximumWidth).toBeGreaterThan(640)
      await expect(separator).toHaveAttribute('aria-valuemax', String(maximumWidth))
      await dragResizeHandleBy(page, -1000)
      expect(await panelWidthOf(page)).toBeCloseTo(maximumWidth, 0)
      await dragResizeHandleBy(page, 1000)
      expect(await panelWidthOf(page)).toBeCloseTo(280, 0)
    })

    await test.step('narrows a wide panel when the window shrinks so it never covers the chat', async () => {
      await dragResizeHandleBy(page, -1000)
      const viewport = page.viewportSize()!
      await page.setViewportSize({ width: viewport.width - 200, height: viewport.height })
      const mainBox = (await mainOf(page).boundingBox())!
      await expect.poll(() => panelWidthOf(page)).toBeCloseTo(Math.floor(mainBox.width - 320), 0)
      const panelBox = (await panelOf(page).boundingBox())!
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1)
      await page.setViewportSize(viewport)
      const restoredMaximumWidth = Math.floor((await mainOf(page).boundingBox())!.width - 320)
      await expect.poll(() => panelWidthOf(page)).toBeCloseTo(restoredMaximumWidth, 0)
      await dragResizeHandleBy(page, 1000)
      await expect.poll(() => panelWidthOf(page)).toBeCloseTo(280, 0)
    })

    await test.step('scrolls the tab list horizontally when the panel is narrow and keeps the selected tab visible', async () => {
      expect(await panelWidthOf(page)).toBeCloseTo(280, 0)
      const overflowX = await tabListOf(page).evaluate((element) => getComputedStyle(element).overflowX)
      expect(['auto', 'scroll']).toContain(overflowX)
      expect(await isTabListScrollable(page)).toBe(true)
      await tabOf(page, 'Files').focus()
      await page.keyboard.press('End')
      await expect(tabOf(page, 'Members')).toHaveAttribute('aria-selected', 'true')
      await expect(tabOf(page, 'Members')).toBeInViewport()
    })
  })

  test('As a member, I see the selected tab distinct in light and dark mode and the panel in the app text colour', async ({
    page,
  }) => {
    await openChat(page, 'Invoice bug')
    const styleSignatureOf = (tabName: string) =>
      tabOf(page, tabName).evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.color, style.backgroundColor, style.fontWeight, style.borderBottomColor, style.boxShadow].join(
          '|',
        )
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
})
