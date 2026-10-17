import {
  agentReplyText,
  chatLinkOf,
  composerOf,
  draftIconOf,
  expect,
  messageContaining,
  messageItemsOf,
  openChat,
  type Page,
  sendMessage,
  sidebarOf,
  switchWorkspace,
  test,
  unreadIconOf,
} from './fixtures'
import type { WorkerStack } from './stack'

const menuButtonOf = (page: Page, chatName: string) =>
  page.getByRole('button', { name: `Chat actions for ${chatName}` })
const makeAliceAdminOf = async (workerStack: WorkerStack, chatId: string) => {
  await workerStack.database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id)
    values ('workspace-acme', ${chatId}, 'member-alice', 'owner')
    on conflict (workspace_id, chat_id, user_id) do update set role_id = 'owner'`
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('shows the unread indicator, its place, colours and tooltip, per workspace', async ({ page, workerStack }) => {
  await makeAliceAdminOf(workerStack, 'chat-standup')
  await test.step('shows the icon on chats with unread messages only', async () => {
    await expect(unreadIconOf(page, 'Standup')).toBeVisible()
    await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
    for (const readChatName of ['Welcome', 'Invoice bug', 'Research']) {
      await expect(unreadIconOf(page, readChatName)).toHaveCount(0)
    }
  })

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

  await test.step('keeps the unread state per workspace', async () => {
    await switchWorkspace(page, 'Globex')
    await expect(sidebarOf(page).getByRole('img', { name: 'Unread messages' })).toHaveCount(0)
    await switchWorkspace(page, 'Acme')
    await expect(unreadIconOf(page, 'Standup')).toBeVisible()
  })
})

test('opening a chat marks only that chat read, for good', async ({ page }) => {
  await test.step('only clears the opened chat', async () => {
    await openChat(page, 'Standup')
    await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
  })

  for (const chatName of ['Standup', 'Setup helper'])
    await test.step(`clears the icon of ${chatName} when it is opened and keeps it cleared`, async () => {
      await openChat(page, chatName)
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)
      await openChat(page, 'Welcome')
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)
      await openChat(page, chatName)
      await expect(unreadIconOf(page, chatName)).toHaveCount(0)
    })
})

test('notifies agent replies only in chats that are not open, never own messages', async ({ page }) => {
  await test.step('never shows the icon for the member own messages', async () => {
    await openChat(page, 'Welcome')
    await sendMessage(page, 'My own message')
    await expect(messageItemsOf(page).last()).toContainText('My own message')
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)
    await openChat(page, 'Standup')
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)
  })

  await test.step('shows the icon once the agent reply arrives in a chat that is not open, and clears it on opening', async () => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Question to the agent')
    await chatLinkOf(page, 'Welcome').click()
    await expect(unreadIconOf(page, 'Research')).toBeVisible()
    await openChat(page, 'Research')
    await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  })

  await test.step('keeps a chat read when a reply arrived while it was open, also after switching away', async () => {
    await openChat(page, 'Setup helper')
    await sendMessage(page, 'Another question')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(unreadIconOf(page, 'Setup helper')).toHaveCount(0)
    await openChat(page, 'Welcome')
    await expect(unreadIconOf(page, 'Setup helper')).toHaveCount(0)
  })
})

test('shows the unread and draft icons side by side, distinct in light and dark mode', async ({
  page,
  workerStack,
}) => {
  await makeAliceAdminOf(workerStack, 'chat-setup-helper')
  await openChat(page, 'Setup helper')
  await sendMessage(page, 'Question to the agent')
  await composerOf(page).fill('Draft for later')
  await chatLinkOf(page, 'Welcome').click()
  await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
  await expect(draftIconOf(page, 'Setup helper')).toBeVisible()

  await test.step('shows the exclamation left of the pencil, both before the menu button', async () => {
    const unreadBox = (await unreadIconOf(page, 'Setup helper').boundingBox())!
    const draftBox = (await draftIconOf(page, 'Setup helper').boundingBox())!
    const menuButtonBox = (await menuButtonOf(page, 'Setup helper').boundingBox())!
    expect(unreadBox.x + unreadBox.width).toBeLessThanOrEqual(draftBox.x)
    expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(menuButtonBox.x)
  })

  for (const colorScheme of ['light', 'dark'] as const)
    await test.step(`distinguishes the exclamation from the pencil in ${colorScheme} mode`, async () => {
      await page.emulateMedia({ colorScheme })
      const colorOf = (iconName: string) =>
        chatLinkOf(page, 'Setup helper')
          .getByRole('img', { name: iconName })
          .evaluate((icon) => getComputedStyle(icon).color)
      expect(await colorOf('Unread messages')).not.toBe(await colorOf('Has unsent draft'))
    })
})
