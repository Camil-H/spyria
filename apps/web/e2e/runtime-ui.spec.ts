import {
  agentReplyText,
  expect,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const research = 'chat-research'
const slowScript = { wordDelayMilliseconds: 4000 }
const newSessionNotice = 'The agent started a new session; it does not remember earlier messages'
const runtimeStatusOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Runtime' })
const stopButtonOf = (page: Page) => mainOf(page).getByRole('button', { name: 'Stop' })
const retryButtonOf = (page: Page) => runtimeStatusOf(page).getByRole('button', { name: 'Could not start · Retry' })
const itemsWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })

const turnOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select agent_turn_message_id from chats where id = ${chatId}`)[0]
    ?.agent_turn_message_id
const runtimeStateOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select state from runtimes where chat_id = ${chatId}`)[0]?.state
const enqueueJob = (workerStack: WorkerStack, type: string, payload: object) =>
  workerStack.database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
    values ('workspace-acme', ${crypto.randomUUID()}, ${type}, ${JSON.stringify(payload)}::jsonb, now(), 0, 'queued')`

const triggerIdleStop = async (workerStack: WorkerStack, chatId: string) => {
  await expect.poll(() => turnOf(workerStack, chatId)).toBeNull()
  await workerStack.database.$client`
    update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${chatId}`
  await enqueueJob(workerStack, 'runtime.sweep', {})
  await expect.poll(() => runtimeStateOf(workerStack, chatId)).toBe('stopped')
}

const stopRuntime = async (workerStack: WorkerStack, chatId: string) => {
  const [runtime] = await workerStack.database.$client`
    update runtimes set state = 'stopping', state_changed_at = now() where chat_id = ${chatId} returning id`
  await enqueueJob(workerStack, 'runtime.stop', { runtimeId: runtime?.id })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('without a warm runtime', () => {
  test.use({ warmRuntimes: false, fakeBootMilliseconds: 1_500 })

  test('1. a runtime chat without a runtime shows Not started; a channel shows no runtime status', async ({ page }) => {
    await openChat(page, 'Research')
    await expect(runtimeStatusOf(page)).toHaveText('Not started')
    await openChat(page, 'Standup')
    await expect(runtimeStatusOf(page)).toHaveCount(0)
  })

  test('5. a runtime that cannot start shows one Could not start · Retry chip and a notice; clicking it starts the runtime and answers the prompt', async ({
    page,
    failRuntimeCreation,
  }) => {
    await failRuntimeCreation(true)
    await openChat(page, 'Research')
    await sendMessage(page, 'Start please')

    await expect(runtimeStatusOf(page)).toHaveText('Could not start · Retry')
    await expect(retryButtonOf(page)).toBeVisible()
    await expect(mainOf(page).getByRole('button', { name: /Retry/ })).toHaveCount(1)
    await expect(itemsWith(page, 'The agent could not start')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await failRuntimeCreation(false)
    await retryButtonOf(page).click()

    await expect(runtimeStatusOf(page)).toHaveText('Starting…')
    await expect(retryButtonOf(page)).toHaveCount(0)
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await expect(itemsWith(page, agentReplyText)).toHaveCount(1)
    await expect(messageItemsOf(page)).toHaveCount(3)
    await expect(messageItemsOf(page).nth(0)).toContainText('Start please')
    await expect(messageItemsOf(page).nth(1)).toContainText('The agent could not start')
    await expect(messageItemsOf(page).nth(2)).toContainText(agentReplyText)
  })

  test('10. another member watching sees Starting…, Ready, the indicator and Stop, and can stop the agent', async ({
    page,
    browser,
    workerStack,
    agentScript,
  }) => {
    await agentScript(research, slowScript)
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Research')
    await expect(runtimeStatusOf(bobPage)).toHaveText('Not started')
    await openChat(page, 'Research')
    await sendMessage(page, 'Work while Bob watches')

    await expect(runtimeStatusOf(bobPage)).toHaveText('Starting…')
    await expect(runtimeStatusOf(bobPage)).toHaveText('Ready')
    await expect(workingIndicatorOf(bobPage)).toBeVisible()
    await expect(stopButtonOf(bobPage)).toBeVisible()
    await stopButtonOf(bobPage).click()

    await expect(itemsWith(bobPage, 'Stopped by Bob')).toHaveCount(1)
    await expect(itemsWith(page, 'Stopped by Bob')).toHaveCount(1)
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(stopButtonOf(page)).toHaveCount(0)
    await bobPage.context().close()
  })
})

test.describe('a warm runtime with a slow boot', () => {
  test.use({ fakeBootMilliseconds: 1_500 })

  test('3. after the idle stop the header shows Sleeping; a prompt wakes the runtime and keeps the history', async ({
    page,
    workerStack,
  }) => {
    await openChat(page, 'Research')
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Before the sleep')
    await expect(itemsWith(page, agentReplyText)).toHaveCount(1)
    await triggerIdleStop(workerStack, research)
    await expect(runtimeStatusOf(page)).toHaveText('Sleeping')

    await sendMessage(page, 'After the sleep')
    await expect(runtimeStatusOf(page)).toHaveText('Starting…')
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await expect(itemsWith(page, agentReplyText)).toHaveCount(2)
    await expect(messageItemsOf(page)).toHaveCount(4)
    await expect(messageItemsOf(page).nth(0)).toContainText('Before the sleep')
    await expect(messageItemsOf(page).nth(2)).toContainText('After the sleep')
  })
})

test('4. with its host stopped the header shows Host offline and a prompt gets a notice; the host coming back answers it', async ({
  page,
  workerStack,
}) => {
  await openChat(page, 'Research')
  await expect(runtimeStatusOf(page)).toHaveText('Ready')
  await workerStack.stopRuntimeHost()
  await expect(runtimeStatusOf(page)).toHaveText('Host offline')

  await sendMessage(page, 'Are you there?')
  await expect(itemsWith(page, 'The runtime host is offline')).toHaveCount(1)
  await workerStack.startRuntimeHost()
  await expect(runtimeStatusOf(page)).toHaveText(/^(Ready|Sleeping)$/)
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1)
  await expect(itemsWith(page, 'The runtime host is offline')).toHaveCount(1)
  await expect(runtimeStatusOf(page)).toHaveText('Ready')
})

test('8. a runtime stopped mid-turn ends the turn with a notice, and the next prompt wakes it and is answered', async ({
  page,
  workerStack,
  agentScript,
}) => {
  await agentScript(research, slowScript)
  await openChat(page, 'Research')
  await sendMessage(page, 'Work until stopped')
  await expect(stopButtonOf(page)).toBeVisible()
  await agentScript(research, {})
  await stopRuntime(workerStack, research)

  await expect(itemsWith(page, 'The agent stopped before finishing')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await sendMessage(page, 'Wake up')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1)
  await expect(runtimeStatusOf(page)).toHaveText('Ready')
})

test('9. a lost agent conversation and session are replaced, the prompt is answered and the new session notice shows once', async ({
  page,
  workerStack,
}) => {
  await openChat(page, 'Research')
  await sendMessage(page, 'Remember the number 42')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(1)
  await expect.poll(() => turnOf(workerStack, research)).toBeNull()
  await workerStack.database.$client`
    update runtimes set agent_conversation_id = ${crypto.randomUUID()} where chat_id = ${research}`
  await workerStack.fakeHost({ forgetSessions: 'true' })

  await sendMessage(page, 'What was the number?')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(2)
  await expect(itemsWith(page, newSessionNotice)).toHaveCount(1)
  await sendMessage(page, 'And now?')
  await expect(itemsWith(page, agentReplyText)).toHaveCount(3)
  await expect(itemsWith(page, newSessionNotice)).toHaveCount(1)
})
