import { openPageAs } from '../stack'
import {
  addParticipant,
  alicesWelcomeMessage,
  expect,
  mainOf,
  messageActionOf,
  messageActionsOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openWelcome,
  type Page,
  repliesOf,
  replyBoxOf,
  replyInThread,
  sendMessage,
  test,
  threadToggleName,
  threadToggleOf,
  unreadIconOf,
} from './fixtures'

const threadOf = (page: Page) =>
  messageItemsOf(page).filter({ has: page.getByRole('button', { name: threadToggleName }) })

test.describe('Threads', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see a thread reply under my message as a collapsed "1 reply · 1 new", not in the channel flow', {
    tag: ['@spec-31'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openWelcome(page)
    await openWelcome(bobPage)
    await replyInThread(bobPage, 'Count me in for lunch')
    await expect(threadToggleOf(page)).toHaveText('1 reply · 1 new')
    await expect(threadToggleOf(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(messageContaining(page, 'Count me in for lunch')).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member, I open a thread: its reply and composer show, "new" clears, and my reply reaches Bob live', {
    tag: ['@spec-31', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openWelcome(page)
    await openWelcome(bobPage)
    await replyInThread(bobPage, 'Count me in for lunch')
    await threadToggleOf(page).click()
    await expect(repliesOf(page)).toHaveText([/Bob.*Count me in for lunch/])
    await expect(replyBoxOf(page)).toBeVisible()
    await expect(threadToggleOf(page)).toHaveText('1 reply')
    await replyBoxOf(page).fill('Great, see you at noon')
    await replyBoxOf(page).press('ControlOrMeta+Enter')
    await expect(threadToggleOf(bobPage)).toHaveText('2 replies')
    await expect(repliesOf(bobPage)).toHaveText([/Count me in for lunch/, /Great, see you at noon/])
    await bobPage.context().close()
  })

  test('As a member, a thread reply does not make a channel unread for me, while a new top-level message does', {
    tag: ['@spec-31'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openWelcome(bobPage)
    await openChat(page, 'Invoice bug')
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)
    await replyInThread(bobPage, 'Only in the thread')
    await expect
      .poll(
        async () =>
          (await workerStack.database.$client`select 1 from messages where body = 'Only in the thread'`).length,
      )
      .toBe(1)
    await expect(unreadIconOf(page, 'Welcome')).toHaveCount(0)
    await sendMessage(bobPage, 'For everyone')
    await expect(unreadIconOf(page, 'Welcome')).toBeVisible()
    await bobPage.context().close()
  })

  test('As a reader, I open a thread but its composer reads "You can read this chat"', { tag: ['@spec-31'] }, async ({
    page,
    browser,
    workerStack,
  }) => {
    await addParticipant(workerStack, 'chat-welcome', 'member-lee', 'reader')
    await openWelcome(page)
    await replyInThread(page, 'Readers can see this')
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await openWelcome(leePage)
    await expect(
      await messageActionOf(messageContaining(leePage, alicesWelcomeMessage), 'Reply in thread'),
    ).toHaveCount(0)
    await threadToggleOf(leePage).click()
    await expect(repliesOf(leePage)).toHaveText([/Readers can see this/])
    await expect(threadOf(leePage).getByText('You can read this chat')).toBeVisible()
    await expect(threadOf(leePage).getByRole('button', { name: 'Send' })).toBeDisabled()
    await leePage.context().close()
  })

  test('As a member, I edit and delete my reply in a thread, and a deleted root keeps its thread without Reply in thread', {
    tag: ['@spec-31'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openWelcome(page)
    await openWelcome(bobPage)
    await replyInThread(bobPage, 'First draft')
    await replyInThread(bobPage, 'Keep this one')
    await (await messageActionOf(repliesOf(bobPage).filter({ hasText: 'First draft' }), 'Edit')).click()
    await bobPage.getByRole('textbox', { name: 'Edit message' }).fill('Second draft')
    await bobPage.getByRole('button', { name: 'Save' }).click()
    await expect(repliesOf(bobPage).filter({ hasText: 'Second draft' })).toContainText('(edited)')
    await (await messageActionOf(repliesOf(bobPage).filter({ hasText: 'Second draft' }), 'Delete')).click()
    await bobPage.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Delete' }).click()
    await expect(repliesOf(bobPage)).toHaveText([/This message was deleted/, /Keep this one/])

    await (await messageActionOf(messageContaining(page, alicesWelcomeMessage), 'Delete')).click()
    await page.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Delete' }).click()
    const deletedRoot = messageItemsOf(page).filter({ hasText: 'This message was deleted' }).first()
    await expect(messageActionsOf(deletedRoot)).toHaveCount(0)
    await expect(threadToggleOf(page)).toHaveText('2 replies · 1 new')
    await threadToggleOf(page).click()
    await expect(repliesOf(page)).toHaveText([/This message was deleted/, /Keep this one/])
    await expect(replyBoxOf(page)).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member, I find no Reply in thread on a runtime chat’s messages', { tag: ['@spec-31'] }, async ({
    page,
  }) => {
    await openChat(page, 'Invoice bug')
    await expect(messageContaining(page, 'Why do invoices show the wrong total?')).toBeVisible()
    await expect(messageActionsOf(mainOf(page))).toHaveCount(0)
    await expect(threadToggleOf(page)).toHaveCount(0)
  })
})
