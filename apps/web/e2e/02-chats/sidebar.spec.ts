import { openMenu, signedOutScreenOf } from '../01-access/fixtures'
import {
  boundingBoxOf,
  chatLinkOf,
  expect,
  mainOf,
  type Page,
  projectGroupOf,
  sidebarOf,
  switcherOf,
  test,
  unreadIconOf,
} from '../fixtures'
import { chatMenuButtonOf, chatRowIn, looseChatsOf } from './fixtures'

const dialogOf = (page: Page, dialogName: string) => page.getByRole('dialog', { name: dialogName })
const cancelDialog = async (page: Page, dialogName: string) => {
  await dialogOf(page, dialogName).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialogOf(page, dialogName)).toHaveCount(0)
}
const logoutDialogOf = (page: Page, workspaceName: string) =>
  page.getByRole('dialog', { name: `Log out of ${workspaceName}` })
const makeAliceAdminOf = async (
  workerStack: Parameters<Parameters<typeof test>[2]>[0]['workerStack'],
  chatId: string,
) => {
  await workerStack.database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id)
    values ('workspace-acme', ${chatId}, 'member-alice', 'owner')
    on conflict (workspace_id, chat_id, user_id) do update set role_id = 'owner'`
}

test.describe('Sidebar', () => {
  test.use({ runtimeHost: false, warmRuntimes: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see the tree with type icons and tooltips, the toolbar icons, focus rings kept inside rows and menu triggers inset', async ({
    page,
  }) => {
    await test.step('keeps the keyboard focus ring of a chat row inside the row so neighbours are not cut', async () => {
      const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
      await welcomeRow.focus()
      await expect(welcomeRow).toHaveCSS('outline-style', 'solid')
      await expect(welcomeRow).toHaveCSS('outline-offset', '-2px')
    })
    await test.step('hints the chat type with an icon and shows no type text or owner name', async () => {
      const invoiceBugRow = chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')
      await expect(invoiceBugRow.getByRole('img', { name: 'Runtime chat' })).toBeVisible()
      await expect(invoiceBugRow).toHaveText('Invoice bug')
      const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
      await expect(welcomeRow.getByRole('img', { name: 'Channel' })).toBeVisible()
      await expect(welcomeRow).toHaveText('Welcome')
      await expect(sidebarOf(page)).not.toContainText('Bob')
    })
    await test.step('explains the chat type in a tooltip when hovering its icon', async () => {
      for (const [groupName, chatName, typeName] of [
        ['Billing', 'Invoice bug', 'Runtime chat'],
        ['Onboarding', 'Welcome', 'Channel'],
      ] as const)
        await expect(async () => {
          await mainOf(page).hover({ position: { x: 10, y: 10 } })
          await chatRowIn(projectGroupOf(page, groupName), chatName).getByRole('img', { name: typeName }).hover()
          await expect(page.getByRole('tooltip', { name: typeName })).toBeVisible({ timeout: 2_000 })
        }).toPass()
    })
    for (const actionName of ['New project', 'New chat'])
      await test.step(`shows ${actionName} as an icon at the top right with a tooltip`, async () => {
        const actionButton = sidebarOf(page).getByRole('button', { name: actionName })
        await expect(actionButton).toHaveText('')
        const sidebarBox = await boundingBoxOf(sidebarOf(page))
        const buttonBox = await boundingBoxOf(actionButton)
        expect(buttonBox.x).toBeGreaterThan(sidebarBox.x + sidebarBox.width / 2)
        expect(buttonBox.y).toBeLessThan(sidebarBox.y + 60)
        await actionButton.hover()
        await expect(page.getByRole('tooltip', { name: actionName })).toBeVisible()
        await mainOf(page).hover()
        await mainOf(page).hover({ position: { x: 10, y: 10 } })
        await expect(page.getByRole('tooltip')).toHaveCount(0)
      })

    await test.step('keeps hovered menu triggers inset from the scroll area edge so their highlight is not clipped', async () => {
      const scrollAreaBox = await boundingBoxOf(looseChatsOf(page).locator('..'))
      for (const triggerName of ['Project actions for Billing', 'Chat actions for Invoice bug']) {
        const trigger = sidebarOf(page).getByRole('button', { name: triggerName })
        await trigger.hover()
        const triggerBox = await boundingBoxOf(trigger)
        expect(scrollAreaBox.x + scrollAreaBox.width - (triggerBox.x + triggerBox.width)).toBeGreaterThanOrEqual(4)
      }
    })
  })

  test('As a member, I collapse the sidebar from the icon left of the workspace name and find it collapsed after a reload', async ({
    page,
  }) => {
    const collapseButton = sidebarOf(page).getByRole('button', { name: 'Collapse sidebar' })
    const expandButton = sidebarOf(page).getByRole('button', { name: 'Expand sidebar' })

    await test.step('shows the collapse icon at the top left, before the workspace name', async () => {
      const sidebarBox = await boundingBoxOf(sidebarOf(page))
      const collapseBox = await boundingBoxOf(collapseButton)
      const switcherBox = await boundingBoxOf(switcherOf(page))
      expect(collapseBox.x).toBeLessThan(sidebarBox.x + 24)
      expect(collapseBox.y).toBeLessThan(sidebarBox.y + 24)
      expect(collapseBox.x + collapseBox.width).toBeLessThanOrEqual(switcherBox.x)
    })

    await test.step('hides the tree and widens the chat when collapsed, keeping the expand icon in place', async () => {
      const collapseBox = await boundingBoxOf(collapseButton)
      const mainWidthBefore = (await boundingBoxOf(mainOf(page))).width
      await collapseButton.click()
      await expect(switcherOf(page)).toHaveCount(0)
      await expect(looseChatsOf(page)).toHaveCount(0)
      const expandBox = await boundingBoxOf(expandButton)
      expect(expandBox.x).toBeCloseTo(collapseBox.x, 0)
      expect(expandBox.y).toBeCloseTo(collapseBox.y, 0)
      expect((await boundingBoxOf(mainOf(page))).width).toBeGreaterThan(mainWidthBefore + 150)
    })

    await test.step('stays collapsed after a reload and expands again', async () => {
      await page.reload()
      await expect(expandButton).toBeVisible()
      await expandButton.click()
      await expect(switcherOf(page)).toBeVisible()
      await expect(looseChatsOf(page)).toBeVisible()
    })
  })

  test('As a member, I resize the sidebar within its bounds, with the mouse or the keyboard, and find the width after a reload', async ({
    page,
  }) => {
    const separator = sidebarOf(page).getByRole('separator', { name: 'Resize sidebar' })
    const sidebarWidth = async () => (await boundingBoxOf(sidebarOf(page))).width
    const dragSeparatorBy = async (horizontalOffset: number) => {
      const handleBox = await boundingBoxOf(separator)
      const handleCenterX = handleBox.x + handleBox.width / 2
      const handleCenterY = handleBox.y + handleBox.height / 2
      await page.mouse.move(handleCenterX, handleCenterY)
      await page.mouse.down()
      await page.mouse.move(handleCenterX + horizontalOffset, handleCenterY, { steps: 8 })
      await page.mouse.up()
    }

    await test.step('exposes the separator on the right edge with its bounds and the default width', async () => {
      await expect(separator).toHaveAttribute('aria-valuemin', '240')
      await expect(separator).toHaveAttribute('aria-valuemax', '400')
      await expect(separator).toHaveAttribute('aria-valuenow', '256')
      const sidebarBox = await boundingBoxOf(sidebarOf(page))
      const separatorBox = await boundingBoxOf(separator)
      const borderWidth = await sidebarOf(page).evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).borderRightWidth),
      )
      expect(separatorBox.x + separatorBox.width).toBeCloseTo(sidebarBox.x + sidebarBox.width - borderWidth, 0)
      expect(sidebarBox.width).toBeCloseTo(256, 0)
    })

    await test.step('changes the width by 16px with the arrow keys', async () => {
      await separator.focus()
      await page.keyboard.press('ArrowRight')
      await expect(separator).toHaveAttribute('aria-valuenow', '272')
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      await expect(separator).toHaveAttribute('aria-valuenow', '240')
      expect(await sidebarWidth()).toBeCloseTo(240, 0)
    })

    await test.step('widens when dragged right, stopping at the maximum, and narrows down to the minimum', async () => {
      await dragSeparatorBy(100)
      expect(await sidebarWidth()).toBeCloseTo(340, 0)
      expect(await page.evaluate(() => getSelection()?.toString())).toBe('')
      await dragSeparatorBy(300)
      expect(await sidebarWidth()).toBeCloseTo(400, 0)
      await dragSeparatorBy(-400)
      expect(await sidebarWidth()).toBeCloseTo(240, 0)
      await expect(switcherOf(page)).toBeVisible()
      const sidebarBox = await boundingBoxOf(sidebarOf(page))
      const newChatBox = await boundingBoxOf(sidebarOf(page).getByRole('button', { name: 'New chat' }))
      expect(newChatBox.x + newChatBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width - 12)
    })

    await test.step('keeps the width after a reload', async () => {
      await dragSeparatorBy(60)
      await page.reload()
      await expect(separator).toHaveAttribute('aria-valuenow', '300')
      expect(await sidebarWidth()).toBeCloseTo(300, 0)
    })
  })

  test('As a member, I see dialogs titled in the app text colour and the chat types offered in one row', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    const expectDialogTitleToUseAppTextColor = async (dialogName: string) => {
      const dialogTitleColor = await dialogOf(page, dialogName)
        .getByRole('heading', { name: dialogName })
        .evaluate((element) => getComputedStyle(element).color)
      const sidebarTextColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
      expect(dialogTitleColor).toBe(sidebarTextColor)
    }

    await test.step('uses the app text color for the new project and new chat dialogs', async () => {
      await page.getByRole('button', { name: 'New project' }).click()
      await expectDialogTitleToUseAppTextColor('New project')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await page.getByRole('button', { name: 'New chat' }).click()
      await expectDialogTitleToUseAppTextColor('New chat')
      await cancelDialog(page, 'New chat')
    })
    await test.step('offers Team channel and AI chat as one row of options', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      const channelOptionBox = await boundingBoxOf(page.getByRole('radio', { name: 'Team channel' }).locator('..'))
      const runtimeOptionBox = await boundingBoxOf(page.getByRole('radio', { name: 'AI chat' }).locator('..'))
      expect(Math.abs(channelOptionBox.y - runtimeOptionBox.y)).toBeLessThan(2)
      expect(runtimeOptionBox.x).toBeGreaterThan(channelOptionBox.x + channelOptionBox.width - 1)
    })
  })

  test('As a member, I reach the workspace menu’s log-out icons with the keyboard, and the menu and the signed-out screen use the app text colour in dark mode', async ({
    page,
  }) => {
    await test.step('reaches the log-out icons with the keyboard', async () => {
      await openMenu(page)
      await page.keyboard.press('Escape')
      await switcherOf(page).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('menuitem', { name: /^Acme/ })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toBeFocused()
      await page.keyboard.press('Escape')
    })
    await openMenu(page)
    await page.keyboard.press('Escape')
    await test.step('uses the app text color in dark mode for the menu and the signed-out screen', async () => {
      await page.emulateMedia({ colorScheme: 'dark' })
      const sidebarColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
      await openMenu(page)
      for (const itemName of ['New workspace', 'Log out of Acme']) {
        const itemColor = await page
          .getByRole('menuitem', { name: itemName })
          .evaluate((element) => getComputedStyle(element).color)
        expect(itemColor).toBe(sidebarColor)
      }
      await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
      await logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Log out' }).click()
      const signedOutColor = await signedOutScreenOf(page, 'Acme').evaluate(
        (element) => getComputedStyle(element).color,
      )
      expect(signedOutColor).toBe(sidebarColor)
    })
  })

  test('As a member, I see the unread icon at the end of the row as an outline in the text colour, with a tooltip', async ({
    page,
    workerStack,
  }) => {
    await makeAliceAdminOf(workerStack, 'chat-standup')
    await expect(unreadIconOf(page, 'Standup')).toBeVisible()
    await test.step('places the icon at the right end of the row, before the menu button', async () => {
      const iconBox = await boundingBoxOf(unreadIconOf(page, 'Standup'))
      const nameBox = await boundingBoxOf(chatLinkOf(page, 'Standup').getByText('Standup', { exact: true }))
      const menuButtonBox = await boundingBoxOf(chatMenuButtonOf(page, 'Standup'))
      expect(iconBox.x).toBeGreaterThan(nameBox.x + nameBox.width)
      expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(menuButtonBox.x)
    })
    for (const colorScheme of ['light', 'dark'] as const)
      await test.step(`is an unfilled outline in the main text color in ${colorScheme} mode`, async () => {
        await page.emulateMedia({ colorScheme })
        const sidebarTextColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
        const iconStyle = await unreadIconOf(page, 'Standup').evaluate((icon) => {
          const style = getComputedStyle(icon)
          return { color: style.color, fill: style.fill }
        })
        expect(iconStyle.fill).toBe('none')
        expect(iconStyle.color).toBe(sidebarTextColor)
      })

    await test.step('shows a tooltip on hover and exposes the icon as an image', async () => {
      await unreadIconOf(page, 'Standup').hover()
      await expect(page.getByRole('tooltip', { name: 'Unread messages' })).toBeVisible()
    })
  })
})
