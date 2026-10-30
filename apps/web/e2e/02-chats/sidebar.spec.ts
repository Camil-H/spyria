import { openMenu, signedOutScreenOf } from '../01-access/fixtures'
import {
  chatAction,
  chatLinkOf,
  composerOf,
  expect,
  mainOf,
  openChat,
  type Page,
  projectAction,
  projectGroupOf,
  sendMessage,
  sidebarOf,
  switcherOf,
  test,
  unreadIconOf,
} from '../fixtures'
import type { WorkerStack } from '../stack'
import { chatRowIn, draftIconOf, looseChatsOf } from './fixtures'

const dialogOf = (page: Page, dialogName: string) => page.getByRole('dialog', { name: dialogName })
const cancelDialog = async (page: Page, dialogName: string) => {
  await dialogOf(page, dialogName).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialogOf(page, dialogName)).toHaveCount(0)
}
const logoutDialogOf = (page: Page, workspaceName: string) =>
  page.getByRole('dialog', { name: `Log out of ${workspaceName}` })
const menuButtonOf = (page: Page, chatName: string) =>
  page.getByRole('button', { name: `Chat actions for ${chatName}` })
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
          await chatRowIn(projectGroupOf(page, groupName), chatName).getByRole('img', { name: typeName }).hover()
          await expect(page.getByRole('tooltip', { name: typeName })).toBeVisible({ timeout: 2_000 })
        }).toPass()
    })
    for (const actionName of ['New project', 'New chat'])
      await test.step(`shows ${actionName} as an icon at the top right with a tooltip`, async () => {
        const actionButton = sidebarOf(page).getByRole('button', { name: actionName })
        await expect(actionButton).toHaveText('')
        const sidebarBox = await sidebarOf(page).boundingBox()
        const buttonBox = await actionButton.boundingBox()
        expect(buttonBox!.x).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width / 2)
        expect(buttonBox!.y).toBeLessThan(sidebarBox!.y + 60)
        await actionButton.hover()
        await expect(page.getByRole('tooltip', { name: actionName })).toBeVisible()
        await mainOf(page).hover()
        await mainOf(page).hover({ position: { x: 10, y: 10 } })
        await expect(page.getByRole('tooltip')).toHaveCount(0)
      })

    await test.step('keeps hovered menu triggers inset from the scroll area edge so their highlight is not clipped', async () => {
      const scrollAreaBox = await looseChatsOf(page).locator('..').boundingBox()
      for (const triggerName of ['Project actions for Billing', 'Chat actions for Invoice bug']) {
        const trigger = sidebarOf(page).getByRole('button', { name: triggerName })
        await trigger.hover()
        const triggerBox = await trigger.boundingBox()
        expect(scrollAreaBox!.x + scrollAreaBox!.width - (triggerBox!.x + triggerBox!.width)).toBeGreaterThanOrEqual(4)
      }
    })
  })

  test('As a member, I collapse the sidebar from the icon left of the workspace name and find it collapsed after a reload', async ({
    page,
  }) => {
    const collapseButton = sidebarOf(page).getByRole('button', { name: 'Collapse sidebar' })
    const expandButton = sidebarOf(page).getByRole('button', { name: 'Expand sidebar' })

    await test.step('shows the collapse icon at the top left, before the workspace name', async () => {
      const sidebarBox = (await sidebarOf(page).boundingBox())!
      const collapseBox = (await collapseButton.boundingBox())!
      const switcherBox = (await switcherOf(page).boundingBox())!
      expect(collapseBox.x).toBeLessThan(sidebarBox.x + 24)
      expect(collapseBox.y).toBeLessThan(sidebarBox.y + 24)
      expect(collapseBox.x + collapseBox.width).toBeLessThanOrEqual(switcherBox.x)
    })

    await test.step('hides the tree and widens the chat when collapsed, keeping the expand icon in place', async () => {
      const collapseBox = (await collapseButton.boundingBox())!
      const mainWidthBefore = (await mainOf(page).boundingBox())!.width
      await collapseButton.click()
      await expect(switcherOf(page)).toHaveCount(0)
      await expect(looseChatsOf(page)).toHaveCount(0)
      const expandBox = (await expandButton.boundingBox())!
      expect(expandBox.x).toBeCloseTo(collapseBox.x, 0)
      expect(expandBox.y).toBeCloseTo(collapseBox.y, 0)
      expect((await mainOf(page).boundingBox())!.width).toBeGreaterThan(mainWidthBefore + 150)
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
    const sidebarWidth = async () => (await sidebarOf(page).boundingBox())!.width
    const dragSeparatorBy = async (horizontalOffset: number) => {
      const handleBox = (await separator.boundingBox())!
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
      const sidebarBox = (await sidebarOf(page).boundingBox())!
      const separatorBox = (await separator.boundingBox())!
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
      const sidebarBox = (await sidebarOf(page).boundingBox())!
      const newChatBox = (await sidebarOf(page).getByRole('button', { name: 'New chat' }).boundingBox())!
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
    await test.step('uses the app text color for the archive dialogs', async () => {
      await chatAction(page, 'Research', 'Archive chat')
      await expectDialogTitleToUseAppTextColor('Archive chat')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await chatAction(page, 'Research', 'Rename chat')
      await expectDialogTitleToUseAppTextColor('Rename chat')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await projectAction(page, 'Billing', 'Archive project')
      await expectDialogTitleToUseAppTextColor('Archive project')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await projectAction(page, 'Billing', 'Rename project')
      await expectDialogTitleToUseAppTextColor('Rename project')
      await cancelDialog(page, 'Rename project')
    })
    await test.step('offers Team channel and AI chat as one row of options', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      const channelOptionBox = await page.getByRole('radio', { name: 'Team channel' }).locator('..').boundingBox()
      const runtimeOptionBox = await page.getByRole('radio', { name: 'AI chat' }).locator('..').boundingBox()
      expect(Math.abs(channelOptionBox!.y - runtimeOptionBox!.y)).toBeLessThan(2)
      expect(runtimeOptionBox!.x).toBeGreaterThan(channelOptionBox!.x + channelOptionBox!.width - 1)
    })
  })

  test('As a member, I reach the workspace menu’s log-out icons with the keyboard, and the menu, its dialog and the signed-out screen use the app text colour in dark mode', async ({
    page,
  }) => {
    await test.step('reaches the log-out icons with the keyboard', async () => {
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
    await test.step('uses the app text color in dark mode for the menu, the dialog and the signed-out screen', async () => {
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
      const dialogTitleColor = await logoutDialogOf(page, 'Acme')
        .getByRole('heading', { name: 'Log out of Acme' })
        .evaluate((element) => getComputedStyle(element).color)
      expect(dialogTitleColor).toBe(sidebarColor)
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
      const iconBox = (await unreadIconOf(page, 'Standup').boundingBox())!
      const nameBox = (await chatLinkOf(page, 'Standup').getByText('Standup', { exact: true }).boundingBox())!
      const menuButtonBox = (await menuButtonOf(page, 'Standup').boundingBox())!
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

  test('As a member, I see the draft pencil at the end of the row, before the menu button', async ({ page }) => {
    await openChat(page, 'Welcome')
    await test.step('places the pencil at the right end of the row, before the menu button', async () => {
      await composerOf(page).fill('Draft')
      const chatNameBox = await chatLinkOf(page, 'Welcome').getByText('Welcome', { exact: true }).boundingBox()
      const pencilBox = await draftIconOf(page, 'Welcome').boundingBox()
      const menuButtonBox = await page.getByRole('button', { name: 'Chat actions for Welcome' }).boundingBox()
      expect(pencilBox!.x).toBeGreaterThan(chatNameBox!.x + chatNameBox!.width)
      expect(pencilBox!.x + pencilBox!.width).toBeLessThanOrEqual(menuButtonBox!.x)
    })
  })

  test.describe(() => {
    test.use({ runtimeHost: true, warmRuntimes: true })

    test('As a member, I see the unread and draft icons side by side before the menu button, distinct in light and dark mode', async ({
      page,
      workerStack,
    }) => {
      await makeAliceAdminOf(workerStack, 'chat-setup-helper')
      await openChat(page, 'Setup helper')
      await sendMessage(page, 'Question to the agent')
      await composerOf(page).fill('Draft for later')
      await chatLinkOf(page, 'Welcome').click()
      await expect(
        chatLinkOf(page, 'Setup helper').getByRole('img', { name: 'Unread messages · The agent is done' }),
      ).toBeVisible()
      await expect(draftIconOf(page, 'Setup helper')).toBeVisible()

      await test.step('shows the agent status icon left of the pencil, both before the menu button', async () => {
        const unreadBox = (await unreadIconOf(page, 'Setup helper').boundingBox())!
        const draftBox = (await draftIconOf(page, 'Setup helper').boundingBox())!
        const menuButtonBox = (await menuButtonOf(page, 'Setup helper').boundingBox())!
        expect(unreadBox.x + unreadBox.width).toBeLessThanOrEqual(draftBox.x)
        expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(menuButtonBox.x)
      })

      for (const colorScheme of ['light', 'dark'] as const)
        await test.step(`distinguishes the agent status icon from the pencil in ${colorScheme} mode`, async () => {
          await page.emulateMedia({ colorScheme })
          const colorOf = (iconName: string) =>
            chatLinkOf(page, 'Setup helper')
              .getByRole('img', { name: iconName })
              .evaluate((icon) => getComputedStyle(icon).color)
          expect(await colorOf('Unread messages')).not.toBe(await colorOf('Has unsent draft'))
        })
    })
  })
})
