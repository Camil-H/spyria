import {
  agentReplyText,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  research,
  sendMessage,
  test,
  unreadIconOf,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, runtimeStateOf } from './stack'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. first prompt', () => {
  test.use({ warmRuntimes: false })

  test('starts the agent and shows the working indicator until its reply arrives', async ({ page, workerStack }) => {
    expect(await runtimeStateOf(workerStack, research)).toBeUndefined()
    await openChat(page, 'Research')
    await sendMessage(page, 'Find the latest pricing')

    await expect(workingIndicatorOf(page)).toBeVisible()
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page).nth(0)).toContainText('Find the latest pricing')
    await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
    expect(await runtimeStateOf(workerStack, research)).toBe('running')
  })
})

test('5. keeps the prompt and the reply after a reload, and the chat is not unread for the prompter', async ({
  page,
}) => {
  await openChat(page, 'Research')
  await sendMessage(page, 'Remember this')
  await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)

  await page.reload()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
  await expect(messageItemsOf(page)).toHaveCount(2)
  await expect(messageItemsOf(page).nth(0)).toContainText('Remember this')
  await expect(messageItemsOf(page).nth(1)).toContainText(agentReplyText)
  await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
})

test('6. a reload during a turn shows the prompt, then the reply once it completes, without a duplicate', async ({
  page,
  agentScript,
  release,
}) => {
  await agentScript(research, { hold: 'answer' })
  await openChat(page, 'Research')
  await sendMessage(page, 'Stream through a reload')
  await expect(messageContaining(page, 'Understood,')).toHaveCount(1)

  await page.reload()
  await expect(messageContaining(page, 'Stream through a reload')).toHaveCount(1)
  await release('answer')
  await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(2)
})

test('7. another member viewing the chat sees the reply stream in, then the stored reply, and no unread icon', async ({
  page,
  browser,
  workerStack,
  agentScript,
  release,
}) => {
  await agentScript(research, { hold: 'answer' })
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Research')
  await openChat(page, 'Research')
  await sendMessage(page, 'Watch this')

  await expect(messageContaining(bobPage, 'Watch this')).toHaveCount(1)
  const bobReply = messageItemsOf(bobPage).nth(1)
  await expect(bobReply).toContainText('Understood,')
  expect(await bobReply.textContent()).not.toContain(agentReplyText)
  await release('answer')
  await expect(bobReply).toContainText(agentReplyText)
  await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
  await expect(unreadIconOf(bobPage, 'Research')).toHaveCount(0)
  await bobPage.context().close()
})
