import {
  agentReplyText,
  chatLinkOf,
  expect,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  sendMessage,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const agentReply = { timeout: 30_000 }
const coldStart = { timeout: 60_000 }

const research = 'chat-research'
const workingIndicatorOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
const itemsWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const unreadIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Unread messages' })

const turnOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select agent_turn_message_id from chats where id = ${chatId}`)[0]
    ?.agent_turn_message_id
const runtimeStateOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select state from runtimes where chat_id = ${chatId}`)[0]?.state

const triggerIdleStop = async (workerStack: WorkerStack, chatId: string) => {
  await expect.poll(() => turnOf(workerStack, chatId)).toBeNull()
  await workerStack.database.$client`
    update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${chatId}`
  await workerStack.database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
    values ('workspace-acme', ${crypto.randomUUID()}, 'runtime.sweep', '{}'::jsonb, now(), 0, 'queued')`
  await expect.poll(() => runtimeStateOf(workerStack, chatId), agentReply).toBe('stopped')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. first prompt', () => {
  test.use({ warmRuntimes: false })

  test('starts the agent and shows the working indicator until its reply arrives', async ({ page, workerStack }) => {
    test.setTimeout(60_000)
    expect(await runtimeStateOf(workerStack, research)).toBeUndefined()
    await openChat(page, 'Research')
    await sendMessage(page, 'Find the latest pricing')

    await expect(workingIndicatorOf(page)).toBeVisible()
    await expect(itemsWith(page, agentReplyText)).toHaveCount(1, coldStart)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page).nth(0)).toContainText('Find the latest pricing')
    await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
    expect(await runtimeStateOf(workerStack, research)).toBe('running')
  })
})

test.describe('real Agent Server', () => {
  test.use({ agentServer: 'real' })

  test('2. streams the reply into one agent message that grows, then becomes the stored message', async ({
    page,
    agentScript,
  }) => {
    await agentScript(research, { wordDelayMilliseconds: 700 })
    await openChat(page, 'Research')
    await sendMessage(page, 'Stream it slowly')

    const reply = messageItemsOf(page).nth(1)
    await expect(reply).toContainText('Understood,', agentReply)
    expect(await reply.textContent()).not.toContain(agentReplyText)
    await expect(reply).toContainText('Agent')
    await expect(reply).toContainText(agentReplyText, agentReply)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(itemsWith(page, 'Understood,')).toHaveCount(1, agentReply)
    await expect(messageItemsOf(page)).toHaveCount(2)
  })
})

test('4. shows a terminal command as a tool call with its output, followed by the final message', async ({
  page,
  agentScript,
}) => {
  await agentScript(research, { command: 'echo hello' })
  await openChat(page, 'Research')
  await sendMessage(page, 'Say hello in the terminal')

  const toolCallToggle = messageItemsOf(page).nth(1).getByRole('button', { name: 'echo hello' })
  await expect(toolCallToggle).toBeVisible(agentReply)
  await expect(messageItemsOf(page).nth(2)).toContainText(agentReplyText, agentReply)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(3)
  await toolCallToggle.click()
  await expect(messageItemsOf(page).nth(1).getByText('hello', { exact: true })).toBeVisible()
})

test('5. keeps the prompt and the reply after a reload, and the chat is not unread for the prompter', async ({
  page,
}) => {
  await openChat(page, 'Research')
  await sendMessage(page, 'Remember this')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1, agentReply)
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
}) => {
  await agentScript(research, { wordDelayMilliseconds: 700 })
  await openChat(page, 'Research')
  await sendMessage(page, 'Stream through a reload')
  await expect(itemsWith(page, 'Understood,')).toHaveCount(1, agentReply)

  await page.reload()
  await expect(itemsWith(page, 'Stream through a reload')).toHaveCount(1)
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1, agentReply)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(2)
})

test('7. another member viewing the chat sees the reply stream in, then the stored reply, and no unread icon', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  await agentScript(research, { wordDelayMilliseconds: 500 })
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Research')
  await openChat(page, 'Research')
  await sendMessage(page, 'Watch this')

  await expect(itemsWith(bobPage, 'Watch this')).toHaveCount(1)
  const bobReply = messageItemsOf(bobPage).nth(1)
  await expect(bobReply).toContainText('Understood,', agentReply)
  expect(await bobReply.textContent()).not.toContain(agentReplyText)
  await expect(bobReply).toContainText(agentReplyText, agentReply)
  await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
  await expect(itemsWith(bobPage, agentReplyText)).toHaveCount(1)
  await expect(unreadIconOf(bobPage, 'Research')).toHaveCount(0)
  await bobPage.context().close()
})

test('8. after an idle stop, a new prompt resumes the runtime, is answered, and the earlier reply stays', async ({
  page,
  workerStack,
}) => {
  test.setTimeout(60_000)
  await openChat(page, 'Research')
  await sendMessage(page, 'Before the stop')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1, agentReply)
  await triggerIdleStop(workerStack, research)

  await sendMessage(page, 'After the stop')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(2, coldStart)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(4)
  await expect(messageItemsOf(page).nth(0)).toContainText('Before the stop')
  await expect(messageItemsOf(page).nth(1)).toContainText(agentReplyText)
  await expect(messageItemsOf(page).nth(2)).toContainText('After the stop')
  await expect(messageItemsOf(page).nth(3)).toContainText(agentReplyText)
  expect(await runtimeStateOf(workerStack, research)).toBe('running')
})

test.describe('9. no runtime host', () => {
  test.use({ runtimeHost: false })

  test('a prompt shows the notice instead of an endless working indicator', async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Anyone there?')

    await expect(itemsWith(page, 'No runtime host is available')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(2)
    await expect(messageItemsOf(page).nth(0)).toContainText('Anyone there?')
  })
})
