import type { WorkerStack } from '../stack'
import {
  agentReplyText,
  chatLinkOf,
  expect,
  messageContaining,
  messageItemsOf,
  openChat,
  research,
  sendMessage,
  sidebarOf,
  switchWorkspace,
  test,
  unreadIconOf,
} from './fixtures'

const agentStoppedWithError = async (workerStack: WorkerStack, chatId: string) => {
  await workerStack.database.$client.begin(async (sql) => {
    await sql`select 1 from chats where id = ${chatId} for update`
    await sql`
      with agent_rows as (
        select id, kind, body, (select max(seq) from events where chat_id = ${chatId}) + number as seq
        from (values (1, 'reply-before-failure', 'agent', 'Looking into it.'),
          (2, 'failure-notice', 'notice', 'The agent stopped with an error')) as row (number, id, kind, body)
      ), posted as (
        insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
        select 'workspace-acme', ${chatId}, id, seq, 'message.posted', null,
          jsonb_build_object('kind', kind, 'body', body, 'detail', null, 'replyToId', null), now()
        from agent_rows
      )
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      select 'workspace-acme', ${chatId}, id, seq, kind, null, body, now() from agent_rows`
  })
}

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

  test('As a member, the unread icon of a runtime chat shows when its agent stopped with an error, and a channel keeps the plain icon', async ({
    page,
    workerStack,
  }) => {
    await makeAliceAdminOf(workerStack, 'chat-standup')
    await openChat(page, 'Welcome')
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
  })
})
