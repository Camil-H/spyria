import { openPageAs, runtimeStateOf, type WorkerStack } from '../stack'
import {
  addParticipant,
  agentReplyText,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  newSessionNotice,
  openChat,
  type Page,
  research,
  sendMessage,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'

test.describe('Runtime lifecycle', () => {
  const heldScript = { hold: 'answer' }
  const runtimeStatusOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Runtime' })
  const stopButtonOf = (page: Page) => mainOf(page).getByRole('button', { name: 'Stop' })
  const runtimeMenuOf = (page: Page) => runtimeStatusOf(page).getByRole('button', { name: 'Runtime actions' })
  const retryButtonOf = (page: Page) => runtimeStatusOf(page).getByRole('button', { name: 'Could not start · Retry' })

  const turnOf = async (workerStack: WorkerStack, chatId: string) =>
    (await workerStack.database.$client`select agent_turn_message_id from chats where id = ${chatId}`)[0]
      ?.agent_turn_message_id
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

  test.describe(() => {
    test.use({ warmRuntimes: false, fakeBootHold: 'boot' })

    test('As a member, I see Not started on a runtime chat without a runtime, and no runtime status on a channel', {
      tag: ['@spec-10'],
    }, async ({ page }) => {
      await openChat(page, 'Research')
      await expect(runtimeStatusOf(page)).toHaveText('Not started')
      await openChat(page, 'Standup')
      await expect(runtimeStatusOf(page)).toHaveCount(0)
    })

    test('As a prompter, I see one Could not start · Retry chip and a notice when the runtime cannot start; Retry shows Retrying… with a spinner, then starts the runtime and answers the prompt', {
      tag: ['@spec-10', '@spec-25', '@stage-g'],
    }, async ({ page, failRuntimeCreation, release }) => {
      await failRuntimeCreation(true)
      await openChat(page, 'Research')
      await sendMessage(page, 'Start please')

      await expect(runtimeStatusOf(page)).toHaveText('Could not start · Retry')
      await expect(retryButtonOf(page)).toBeVisible()
      await expect(mainOf(page).getByRole('button', { name: /Retry/ })).toHaveCount(1)
      await expect(messageContaining(page, 'The agent could not start')).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await failRuntimeCreation(false)
      await runtimeStatusOf(page).evaluate((status) => {
        const seen = new Set<string>()
        new MutationObserver(() =>
          seen.add(`${status.textContent}${status.querySelector('.animate-spin') ? ' +spinner' : ''}`),
        ).observe(status, { subtree: true, childList: true, characterData: true })
        Object.assign(window, { seenRuntimeStatuses: seen })
      })
      await retryButtonOf(page).click()

      await expect(runtimeStatusOf(page)).toHaveText('Starting…')
      expect(
        await page.evaluate(() => [...(window as unknown as { seenRuntimeStatuses: Set<string> }).seenRuntimeStatuses]),
      ).toEqual(['Retrying… +spinner', 'Starting…'])
      await expect(retryButtonOf(page)).toHaveCount(0)
      await release('boot')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
      await expect(messageItemsOf(page)).toHaveCount(3)
      await expect(messageItemsOf(page).nth(0)).toContainText('Start please')
      await expect(messageItemsOf(page).nth(1)).toContainText('The agent could not start')
      await expect(messageItemsOf(page).nth(2)).toContainText(agentReplyText)
    })

    test('As an Editor watching, I see Starting…, Ready, the indicator and Stop, and I can stop the agent', {
      tag: ['@spec-10'],
    }, async ({ page, browser, workerStack, agentScript, release }) => {
      await agentScript(research, heldScript)
      await addParticipant(workerStack, research, 'member-bob', 'editor')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await openChat(bobPage, 'Research')
      await expect(runtimeStatusOf(bobPage)).toHaveText('Not started')
      await openChat(page, 'Research')
      await sendMessage(page, 'Work while Bob watches')

      await expect(runtimeStatusOf(bobPage)).toHaveText('Starting…')
      await release('boot')
      await expect(runtimeStatusOf(bobPage)).toHaveText('Ready')
      await expect(workingIndicatorOf(bobPage)).toBeVisible()
      await expect(stopButtonOf(bobPage)).toBeVisible()
      await stopButtonOf(bobPage).click()

      await expect(messageContaining(bobPage, 'Stopped by Bob')).toHaveCount(1)
      await expect(messageContaining(page, 'Stopped by Bob')).toHaveCount(1)
      await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(stopButtonOf(page)).toHaveCount(0)
      await bobPage.context().close()
    })
  })

  test.describe(() => {
    test.use({ fakeBootHold: 'boot' })

    test('As a prompter, I see Sleeping after the idle stop, and my next prompt wakes the runtime with the history kept', {
      tag: ['@spec-10', '@slow'],
    }, async ({ page, workerStack, release }) => {
      await openChat(page, 'Research')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      await sendMessage(page, 'Before the sleep')
      await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
      await triggerIdleStop(workerStack, research)
      await expect(runtimeStatusOf(page)).toHaveText('Sleeping')

      await sendMessage(page, 'After the sleep')
      await expect(runtimeStatusOf(page)).toHaveText('Starting…')
      await release('boot')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      await expect(messageContaining(page, agentReplyText)).toHaveCount(2)
      await expect(messageItemsOf(page)).toHaveCount(4)
      await expect(messageItemsOf(page).nth(0)).toContainText('Before the sleep')
      await expect(messageItemsOf(page).nth(2)).toContainText('After the sleep')
      await expect(mainOf(page)).not.toContainText(newSessionNotice)
    })

    test('As the owner, I restart the session or stop the runtime from the status menu, confirming while the agent works; a prompter gets no menu', {
      tag: ['@spec-10'],
    }, async ({ page, browser, workerStack, agentScript, release }) => {
      await addParticipant(workerStack, research, 'member-bob', 'prompter')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await openChat(bobPage, 'Research')
      await expect(runtimeStatusOf(bobPage)).toHaveText('Ready')
      await expect(runtimeMenuOf(bobPage)).toHaveCount(0)
      await bobPage.context().close()

      await agentScript(research, heldScript)
      await openChat(page, 'Research')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      await sendMessage(page, 'Work for a while')
      await expect(workingIndicatorOf(page)).toBeVisible()
      await expect(stopButtonOf(page)).toBeVisible()
      await runtimeMenuOf(page).click()
      await page.getByRole('menuitem', { name: 'Restart session' }).click()
      const confirmation = page.getByRole('dialog', { name: 'Restart session' })
      await expect(confirmation).toContainText('stops this turn')
      await confirmation.getByRole('button', { name: 'Restart session' }).click()
      await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(runtimeStatusOf(page)).toHaveText('Ready')

      await runtimeMenuOf(page).click()
      await page.getByRole('menuitem', { name: 'Stop runtime' }).click()
      await expect(page.getByRole('dialog', { name: 'Stop runtime' })).toHaveCount(0)
      await expect(runtimeStatusOf(page)).toHaveText('Sleeping')
      await sendMessage(page, 'Wake up')
      await expect(runtimeStatusOf(page)).toHaveText('Starting…')
      await release('boot')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
    })
  })

  test('As a prompter, I see Host offline when the host stops and my prompt gets a notice, then the host coming back answers it', {
    tag: ['@spec-10'],
  }, async ({ page, workerStack }) => {
    await openChat(page, 'Research')
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await workerStack.stopRuntimeHost()
    await expect(runtimeStatusOf(page)).toHaveText('Host offline')

    await sendMessage(page, 'Are you there?')
    await expect(messageContaining(page, 'The runtime host is offline')).toHaveCount(1)
    await workerStack.startRuntimeHost()
    await expect(runtimeStatusOf(page)).toHaveText(/^(Ready|Sleeping)$/)
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(messageContaining(page, 'The runtime host is offline')).toHaveCount(1)
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
  })

  test('As a prompter, I see a turn end with a notice when its runtime stops, and my next prompt wakes it and is answered', {
    tag: ['@spec-10'],
  }, async ({ page, workerStack, agentScript }) => {
    await agentScript(research, heldScript)
    await openChat(page, 'Research')
    await sendMessage(page, 'Work until stopped')
    await expect(stopButtonOf(page)).toBeVisible()
    await agentScript(research, {})
    await stopRuntime(workerStack, research)

    await expect(messageContaining(page, 'The agent stopped before finishing')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await sendMessage(page, 'Wake up')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
  })

  test('As a prompter, I get my prompt answered when the agent session was lost, with the new session notice shown once', {
    tag: ['@spec-10'],
  }, async ({ page, workerStack }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Remember the number 42')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect.poll(() => turnOf(workerStack, research)).toBeNull()
    await workerStack.database.$client`
    update runtimes set agent_conversation_id = ${crypto.randomUUID()} where chat_id = ${research}`
    await workerStack.fakeHost({ forgetSessions: 'true' })

    await sendMessage(page, 'What was the number?')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(2)
    await expect(messageContaining(page, newSessionNotice)).toHaveCount(1)
    await sendMessage(page, 'And now?')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(3)
    await expect(messageContaining(page, newSessionNotice)).toHaveCount(1)
  })
})
