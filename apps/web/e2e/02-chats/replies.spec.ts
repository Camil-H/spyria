import { openPageAs } from '../stack'
import {
  alicesWelcomeMessage,
  composerOf,
  expect,
  mainOf,
  messageActionOf,
  messageActionsOf,
  messageContaining,
  openChat,
  openWelcome,
  type Page,
  repliesOf,
  replyBoxOf,
  replyInThread,
  sendMessage,
  test,
} from './fixtures'

const replyBarOf = (page: Page, authorName: string) => mainOf(page).getByText(`Replying to ${authorName}`)
const quoteIn = (message: ReturnType<typeof messageContaining>, authorName: string) =>
  message.getByRole('link', { name: new RegExp(`^In reply to ${authorName}`) })

test.describe('Replies', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I reply to a message: my reply shows it quoted, live for others, and its quote brings me to it', {
    tag: ['@spec-56', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openWelcome(page)
    await openWelcome(bobPage)
    await (await messageActionOf(messageContaining(page, 'Welcome to the team!'), 'Reply')).click()
    await expect(replyBarOf(page, 'Bob')).toBeVisible()
    await expect(composerOf(page)).toBeFocused()
    await sendMessage(page, 'Happy to be on board')
    await expect(replyBarOf(page, 'Bob')).toHaveCount(0)
    const reply = messageContaining(page, 'Happy to be on board')
    await expect(quoteIn(reply, 'Bob')).toContainText('Welcome to the team!')
    await expect(quoteIn(messageContaining(bobPage, 'Happy to be on board'), 'Bob')).toContainText(
      'Welcome to the team!',
    )
    await quoteIn(reply, 'Bob').click()
    await expect(page).toHaveURL(/\?message=message-welcome-1$/)
    await expect(page.locator('[data-message-id="message-welcome-1"]')).toHaveAttribute('aria-current', 'true')
    await bobPage.context().close()
  })

  test('As a member, I cancel a reply and send a plain message', { tag: ['@spec-56'] }, async ({ page }) => {
    await openWelcome(page)
    await (await messageActionOf(messageContaining(page, alicesWelcomeMessage), 'Reply')).click()
    await mainOf(page).getByRole('button', { name: 'Cancel reply' }).click()
    await expect(replyBarOf(page, 'Alice')).toHaveCount(0)
    await sendMessage(page, 'Not a reply after all')
    await expect(messageContaining(page, 'Not a reply after all')).toBeVisible()
    await expect(messageContaining(page, 'Not a reply after all').getByRole('link')).toHaveCount(0)
  })

  test('As a member, I reply to a thread reply from its thread', { tag: ['@spec-56'] }, async ({ page }) => {
    await openWelcome(page)
    await replyInThread(page, 'Lunch at noon?')
    await (await messageActionOf(repliesOf(page).filter({ hasText: 'Lunch at noon?' }), 'Reply')).click()
    await expect(replyBarOf(page, 'Alice')).toBeVisible()
    await expect(replyBoxOf(page)).toBeFocused()
    await replyBoxOf(page).fill('Noon works')
    await replyBoxOf(page).press('ControlOrMeta+Enter')
    await expect(quoteIn(repliesOf(page).filter({ hasText: 'Noon works' }), 'Alice')).toContainText('Lunch at noon?')
  })

  test('As a prompter, I reply to the agent in a runtime chat, while a reader is offered no reply', {
    tag: ['@spec-56'],
  }, async ({ page, browser, workerStack }) => {
    await openChat(page, 'Invoice bug')
    await (await messageActionOf(messageContaining(page, 'The tax is applied twice.'), 'Reply')).click()
    await expect(replyBarOf(page, 'Agent')).toBeVisible()
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await openChat(leePage, 'Invoice bug')
    const leesActions = messageActionsOf(messageContaining(leePage, 'The tax is applied twice.')).getByRole('button')
    await expect(leesActions).toHaveCount(1)
    await expect(leesActions).toHaveAccessibleName('Copy link to message')
    await leePage.context().close()
  })
})
