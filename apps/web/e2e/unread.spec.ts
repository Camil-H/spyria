import { expect, type Page, test } from '@playwright/test'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const mainOf = (page: Page) => page.getByRole('main')
const chatLinkOf = (page: Page, chatName: string) => sidebarOf(page).getByRole('link', { name: chatName })
const unreadIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Unread messages' })
const draftIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Has unsent draft' })
const menuButtonOf = (page: Page, chatName: string) =>
  page.getByRole('button', { name: `Chat actions for ${chatName}` })
const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')
const agentReplyText = 'Understood, working on it.'

const openChat = async (page: Page, chatName: string) => {
  await chatLinkOf(page, chatName).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

const sendMessage = async (page: Page, text: string) => {
  await composerOf(page).fill(text)
  await composerOf(page).press('ControlOrMeta+Enter')
}

const sendThenLeave = async (page: Page, chatName: string, leaveToChatName: string) => {
  await openChat(page, chatName)
  await sendMessage(page, 'Question to the agent')
  await chatLinkOf(page, leaveToChatName).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. indicator', () => {
  test('shows the icon on chats with unread messages only', async ({ page }) => {
    await expect(unreadIconOf(page, 'Standup')).toBeVisible()
    await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
    for (const readChatName of ['Welcome', 'Invoice bug', 'Research']) {
      await expect(unreadIconOf(page, readChatName)).toHaveCount(0)
    }
  })

  test('places the icon at the right end of the row, before the menu button', async ({ page }) => {
    const iconBox = (await unreadIconOf(page, 'Standup').boundingBox())!
    const nameBox = (await chatLinkOf(page, 'Standup').getByText('Standup', { exact: true }).boundingBox())!
    const menuButtonBox = (await menuButtonOf(page, 'Standup').boundingBox())!
    expect(iconBox.x).toBeGreaterThan(nameBox.x + nameBox.width)
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(menuButtonBox.x)
  })
})

test.describe('2. opening marks read', () => {
  for (const chatName of ['Standup', 'Setup helper']) {
    test(`clears the icon of ${chatName} when it is opened and keeps it cleared`, async ({ page }) => {
      await openChat(page, chatName)
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)

      await openChat(page, 'Welcome')
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)
      await openChat(page, chatName)
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)
    })
  }

  test('only clears the opened chat', async ({ page }) => {
    await openChat(page, 'Standup')
    await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
  })
})

test.describe('3. no self notification', () => {
  test('never shows the icon for the member own messages', async ({ page }) => {
    await openChat(page, 'Welcome')
    await sendMessage(page, 'My own message')
    await expect(messageItemsOf(page).last()).toContainText('My own message')
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)

    await openChat(page, 'Standup')
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)
  })
})

test.describe('4. replies while away', () => {
  test('shows the icon once the agent reply arrives in a chat that is not open, and clears it on opening', async ({
    page,
  }) => {
    await sendThenLeave(page, 'Research', 'Welcome')
    await expect(unreadIconOf(page, 'Research')).toBeVisible()

    await openChat(page, 'Research')
    await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
    await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toHaveCount(1)
  })

  test('does not show the icon when the member stays in the chat', async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Question to the agent')
    await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toHaveCount(1)
    await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
  })
})

test.describe('5. open chat stays read', () => {
  test('keeps a chat read when a reply arrived while it was open, also after switching away', async ({ page }) => {
    await openChat(page, 'Setup helper')
    await sendMessage(page, 'Another question')
    await expect(messageItemsOf(page).filter({ hasText: agentReplyText })).toHaveCount(1)

    await openChat(page, 'Welcome')
    await expect(unreadIconOf(page, 'Setup helper')).toHaveCount(0)
  })
})

test.describe('6. with a draft', () => {
  const makeUnreadWithDraft = async (page: Page) => {
    await openChat(page, 'Setup helper')
    await sendMessage(page, 'Question to the agent')
    await composerOf(page).fill('Draft for later')
    await chatLinkOf(page, 'Welcome').click()
    await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
    await expect(draftIconOf(page, 'Setup helper')).toBeVisible()
  }

  test('shows the exclamation left of the pencil, both before the menu button', async ({ page }) => {
    await makeUnreadWithDraft(page)
    const unreadBox = (await unreadIconOf(page, 'Setup helper').boundingBox())!
    const draftBox = (await draftIconOf(page, 'Setup helper').boundingBox())!
    const menuButtonBox = (await menuButtonOf(page, 'Setup helper').boundingBox())!
    expect(unreadBox.x + unreadBox.width).toBeLessThanOrEqual(draftBox.x)
    expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(menuButtonBox.x)
  })

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`distinguishes the exclamation from the pencil in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await makeUnreadWithDraft(page)
      const colorOf = (chatName: string, iconName: string) =>
        chatLinkOf(page, chatName)
          .getByRole('img', { name: iconName })
          .evaluate((icon) => getComputedStyle(icon).color)
      expect(await colorOf('Setup helper', 'Unread messages')).not.toBe(
        await colorOf('Setup helper', 'Has unsent draft'),
      )
    })
  }
})

test.describe('6b. main font color', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`is an unfilled outline in the main text color in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      const sidebarTextColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
      const iconStyle = await unreadIconOf(page, 'Standup').evaluate((icon) => {
        const style = getComputedStyle(icon)
        return { color: style.color, fill: style.fill }
      })
      expect(iconStyle.fill).toBe('none')
      expect(iconStyle.color).toBe(sidebarTextColor)
    })
  }
})

test.describe('7. tooltip and name', () => {
  test('shows a tooltip on hover and exposes the icon as an image', async ({ page }) => {
    const icon = unreadIconOf(page, 'Standup')
    await expect(icon).toBeVisible()
    await icon.hover()
    await expect(page.getByRole('tooltip', { name: 'Unread messages' })).toBeVisible()
  })
})

test.describe('8. workspaces', () => {
  test('keeps the unread state per workspace', async ({ page }) => {
    await page.getByRole('button', { name: 'Switch workspace' }).click()
    await page.getByRole('menuitem', { name: /^Globex/ }).click()
    await expect(sidebarOf(page).getByRole('img', { name: 'Unread messages' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Switch workspace' }).click()
    await page.getByRole('menuitem', { name: /^Acme/ }).click()
    await expect(unreadIconOf(page, 'Standup')).toBeVisible()
  })
})
