import { openPageAs } from '../stack'
import {
  alicesWelcomeMessage,
  expect,
  mainOf,
  messageActionOf,
  messageContaining,
  openChat,
  openWelcome,
  type Page,
  repliesOf,
  replyInThread,
  test,
  threadToggleOf,
} from './fixtures'

const copiedLinkTo = async (page: Page, message: ReturnType<typeof messageContaining>) => {
  await (await messageActionOf(message, 'Copy link to message')).click()
  await expect(await messageActionOf(message, 'Link copied')).toBeVisible()
  return page.evaluate(() => navigator.clipboard.readText())
}

test.describe('Links to messages', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
  })

  test('As a member, I copy a link to a message and opening it brings me to that message, marked, after many later ones', {
    tag: ['@spec-55'],
  }, async ({ page, workerStack }) => {
    await openWelcome(page)
    const link = await copiedLinkTo(page, messageContaining(page, 'Welcome to the team!'))
    expect(link).toMatch(/\/w\/workspace-acme\/chats\/chat-welcome\?message=message-welcome-1$/)
    await workerStack.database.$client.begin(async (sql) => {
      await sql`select 1 from chats where id = 'chat-welcome' for update`
      await sql`
        with fillers as (
          select 'linked-filler-' || number as id, 'Linked filler ' || number as body,
            (select max(seq) from events where chat_id = 'chat-welcome') + number as seq
          from generate_series(1, 60) as number
        ), posted as (
          insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
          select 'workspace-acme', 'chat-welcome', id, seq, 'message.posted', 'member-alice',
            jsonb_build_object('kind', 'member', 'body', body, 'replyToId', null), now()
          from fillers
        )
        insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
        select 'workspace-acme', 'chat-welcome', id, seq, 'member', 'member-alice', body, now() from fillers`
    })
    await expect(messageContaining(page, 'Linked filler 60')).toHaveCount(1)
    await openChat(page, 'Standup')
    await page.goto(link)
    const linked = messageContaining(page, 'Welcome to the team!')
    await expect(linked).toHaveAttribute('aria-current', 'true')
    await expect(linked).toBeInViewport()
    await expect(messageContaining(page, 'Linked filler 60')).not.toBeInViewport()
  })

  test('As a member, I open a link to a thread reply: its thread opens on it', { tag: ['@spec-55'] }, async ({
    page,
  }) => {
    await openWelcome(page)
    await replyInThread(page, 'Linked from elsewhere')
    const link = await copiedLinkTo(page, repliesOf(page).filter({ hasText: 'Linked from elsewhere' }))
    await openChat(page, 'Standup')
    await page.goto(link)
    await expect(threadToggleOf(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(repliesOf(page).filter({ hasText: 'Linked from elsewhere' })).toHaveAttribute('aria-current', 'true')
    await expect(messageContaining(page, alicesWelcomeMessage).first()).not.toHaveAttribute('aria-current')
  })

  test('As a member outside a private chat, a link to one of its messages shows me nothing of it', {
    tag: ['@spec-55'],
  }, async ({ page, browser, workerStack }) => {
    await openChat(page, 'Setup helper')
    const link = await copiedLinkTo(page, messageContaining(page, 'Set up the dev environment.'))
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await leePage.goto(link)
    await expect(mainOf(leePage)).toContainText('Select a chat')
    await expect(leePage).toHaveURL(/\/w\/workspace-acme\/?$/)
    await expect(mainOf(leePage)).not.toContainText('Set up the dev environment.')
    await leePage.context().close()
  })
})
