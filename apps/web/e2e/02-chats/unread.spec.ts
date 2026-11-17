import type { WorkerStack } from '../stack'
import {
  agentReplyText,
  boundingBoxOf,
  chatLinkOf,
  chatMenuButtonOf,
  composerOf,
  draftIconOf,
  expect,
  messageContaining,
  messageItemsOf,
  openChat,
  postMessages,
  research,
  sendMessage,
  sidebarOf,
  switchWorkspace,
  test,
  unreadIconOf,
} from './fixtures'

const agentStoppedWithError = (workerStack: WorkerStack, chatId: string) =>
  postMessages(workerStack, chatId, [
    { id: 'reply-before-failure', kind: 'agent', authorId: null, body: 'Looking into it.' },
    { id: 'failure-notice', kind: 'notice', authorId: null, body: 'The agent stopped with an error' },
  ])

const makeAliceAdminOf = async (workerStack: WorkerStack, chatId: string) => {
  await workerStack.database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id)
    values ('workspace-acme', ${chatId}, 'member-alice', 'owner')
    on conflict (workspace_id, chat_id, user_id) do update set role_id = 'owner'`
}

test.describe('Unread', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see which chats have unread messages, per workspace', async ({ page, workerStack }) => {
    await makeAliceAdminOf(workerStack, 'chat-standup')
    await test.step('shows the icon on chats with unread messages only', async () => {
      await expect(unreadIconOf(page, 'Standup')).toBeVisible()
      await expect(unreadIconOf(page, 'Setup helper')).toBeVisible()
      for (const readChatName of ['Welcome', 'Invoice bug', 'Research']) {
        await expect(unreadIconOf(page, readChatName)).toHaveCount(0)
      }
    })

    await test.step('keeps the unread state per workspace', async () => {
      await switchWorkspace(page, 'Globex')
      await expect(sidebarOf(page).getByRole('img', { name: 'Unread messages' })).toHaveCount(0)
      await switchWorkspace(page, 'Acme')
      await expect(unreadIconOf(page, 'Standup')).toBeVisible()
    })
  })

  test('As a member, opening a chat marks only that chat read, for good', async ({ page }) => {
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

  test('As a member, an agent reply marks a chat unread only when it is not open, and my own messages never do', async ({
    page,
  }) => {
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
      await expect(unreadIconOf(page, 'Research')).toHaveAccessibleName('Unread messages · The agent is done')
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

  test('As a member, the unread icon of a runtime chat shows when its agent stopped with an error, beside my draft and distinct from it, and a channel keeps the plain icon', async ({
    page,
    workerStack,
  }) => {
    await makeAliceAdminOf(workerStack, 'chat-standup')
    await openChat(page, 'Research')
    await composerOf(page).fill('Draft for later')
    await chatLinkOf(page, 'Welcome').click()
    await expect(draftIconOf(page, 'Research')).toBeVisible()
    await agentStoppedWithError(workerStack, research)

    await test.step('names the error in the icon and its tooltip', async () => {
      await expect(unreadIconOf(page, 'Research')).toHaveAccessibleName(
        'Unread messages · The agent stopped with an error',
      )
      await unreadIconOf(page, 'Research').hover()
      await expect(
        page.getByRole('tooltip', { name: 'Unread messages · The agent stopped with an error' }),
      ).toBeVisible()
    })

    await test.step('colors the error apart from the done and channel icons', async () => {
      const colorOf = (chatName: string) =>
        unreadIconOf(page, chatName).evaluate((icon) => getComputedStyle(icon).color)
      await expect(unreadIconOf(page, 'Standup')).toHaveAccessibleName('Unread messages')
      expect(await colorOf('Research')).not.toBe(await colorOf('Standup'))
    })

    await test.step('shows the agent status icon left of the pencil, both before the menu button', async () => {
      const unreadBox = await boundingBoxOf(unreadIconOf(page, 'Research'))
      const draftBox = await boundingBoxOf(draftIconOf(page, 'Research'))
      const menuButtonBox = await boundingBoxOf(chatMenuButtonOf(page, 'Research'))
      expect(unreadBox.x + unreadBox.width).toBeLessThanOrEqual(draftBox.x)
      expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(menuButtonBox.x)
    })

    for (const colorScheme of ['light', 'dark'] as const)
      await test.step(`distinguishes the agent status icon from the pencil in ${colorScheme} mode`, async () => {
        await page.emulateMedia({ colorScheme })
        const colorOf = (iconName: string) =>
          chatLinkOf(page, 'Research')
            .getByRole('img', { name: iconName })
            .evaluate((icon) => getComputedStyle(icon).color)
        expect(await colorOf('Unread messages')).not.toBe(await colorOf('Has unsent draft'))
      })
  })
})
