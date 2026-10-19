import { openPageAs, runtimeStateOf, type WorkerStack } from '../stack'
import {
  addParticipant,
  agentReplyText,
  chipOf,
  chooseRunsOn,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  newSessionNotice,
  openChat,
  type Page,
  research,
  runsOnChipOf,
  runsOnChoiceOf,
  runsOnOf,
  sendButtonOf,
  sendMessage,
  sessionOf,
  sidebarOf,
  signedInMachine,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'

test.describe('Runtime status, sleep and wake', () => {
  const heldScript = { hold: 'answer' }
  const runtimeStatusOf = (page: Page) => mainOf(page).getByRole('status', { name: 'Runtime' })
  const stopButtonOf = (page: Page) => mainOf(page).getByRole('button', { name: 'Stop' })
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

  test.describe('without a warm runtime', () => {
    test.use({ warmRuntimes: false, fakeBootHold: 'boot' })

    test('a runtime chat without a runtime shows Not started; a channel shows no runtime status', {
      tag: ['@spec-10'],
    }, async ({ page }) => {
      await openChat(page, 'Research')
      await expect(runtimeStatusOf(page)).toHaveText('Not started')
      await openChat(page, 'Standup')
      await expect(runtimeStatusOf(page)).toHaveCount(0)
    })

    test('the Runs on chip shows the runtime status with a dot coloured by state: Not started, Starting…, Ready', {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, release }) => {
      const dotColourOf = () =>
        runtimeStatusOf(page)
          .locator('span')
          .first()
          .evaluate((dot) => getComputedStyle(dot).backgroundColor)
      const colourOf = (variable: string) =>
        page.evaluate((name) => {
          const probe = document.body.appendChild(document.createElement('span'))
          probe.style.backgroundColor = `var(${name})`
          const colour = getComputedStyle(probe).backgroundColor
          probe.remove()
          return colour
        }, variable)
      await openChat(page, 'Research')
      await expect(runsOnOf(page)).toHaveValue('runtime')
      await expect(runsOnChipOf(page).getByRole('status', { name: 'Runtime' })).toHaveText('Not started')
      await expect(mainOf(page).getByRole('status', { name: 'Runtime' })).toHaveCount(1)
      expect(await dotColourOf()).toBe(await colourOf('--color-grey-500'))
      const [runsOnRight, statusLeft] = await Promise.all([
        runsOnOf(page).evaluate((select) => select.getBoundingClientRect().right),
        runtimeStatusOf(page).evaluate((status) => status.getBoundingClientRect().left),
      ])
      expect(statusLeft).toBeGreaterThan(runsOnRight)
      expect(statusLeft - runsOnRight).toBeLessThan(24)

      await sendMessage(page, 'Start please')
      await expect(runtimeStatusOf(page)).toHaveText('Starting…')
      expect(await dotColourOf()).toBe(await colourOf('--color-primary-500'))
      await release('boot')
      await expect(runtimeStatusOf(page)).toHaveText('Ready')
      expect(await dotColourOf()).toBe(await colourOf('--color-green-500'))
    })

    test('a runtime that cannot start shows one Could not start · Retry chip and a notice; clicking it shows Retrying… with a spinner, then starts the runtime and answers the prompt', {
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

    test('another member watching sees Starting…, Ready, the indicator and Stop, and can stop the agent', {
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

  test.describe('a warm runtime with a held boot', () => {
    test.use({ fakeBootHold: 'boot' })

    test('after the idle stop the header shows Sleeping; a prompt wakes the runtime and keeps the history', {
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
  })

  test('with its host stopped the header shows Host offline and a prompt gets a notice; the host coming back answers it', {
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

  test('a runtime stopped mid-turn ends the turn with a notice, and the next prompt wakes it and is answered', {
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

  test('a lost agent conversation and session are replaced, the prompt is answered and the new session notice shows once', {
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

test.describe('Choosing where a chat runs', () => {
  const claudeOnMachine = 'Local · Claude Code'
  const codexOnMachine = 'Local · Codex'

  const expectRunsOnLocked = async (page: Page) => {
    await expect(runsOnOf(page)).toBeDisabled()
    await expect(runsOnOf(page)).toHaveValue('runtime')
  }
  const expectRunsOnChoices = async (page: Page, names: string[]) => {
    await expect(runsOnChoiceOf(page).getByRole('radio')).toHaveCount(names.length)
    for (const name of names) await expect(runsOnChoiceOf(page).getByRole('radio', { name })).not.toBeChecked()
  }
  const openSession = async (page: Page) => {
    if (!(await sessionOf(page).isVisible())) await chipOf(page, 'any').click()
    await expect(sessionOf(page)).toBeVisible()
  }
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('a new runtime chat left on HQ runtime runs on a workspace host with the member key', {
    tag: ['@spec-24'],
  }, async ({ page, machine, agentScript }) => {
    await machine(signedInMachine)
    const chatId = await newRuntimeChat(page, 'Left on HQ runtime')
    await openSession(page)
    await expect(runsOnOf(page)).toHaveValue('runtime')
    await page.keyboard.press('Escape')
    await agentScript(chatId, { text: 'Answered on an HQ runtime.' })
    await sendMessage(page, 'Hello HQ runtime')
    await expect(messageContaining(page, 'Answered on an HQ runtime.')).toBeVisible()
    await expect(chipOf(page, 'hq')).toBeVisible()
  })

  test('another member does not see the choice, and Runs on locks once a conversation exists', {
    tag: ['@spec-24'],
  }, async ({ page, browser, workerStack, machine }) => {
    await machine(signedInMachine)
    await addParticipant(workerStack, await newRuntimeChat(page, 'Only Alice chooses'), 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Only Alice chooses')
    await openSession(bobPage)
    await expectRunsOnLocked(bobPage)
    await bobPage.context().close()

    await openSession(page)
    await runsOnOf(page).selectOption({ label: claudeOnMachine })
    await expect(chipOf(page, 'any')).toHaveText('Claude Code · subscription')
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Lock it')
    await expect(messageContaining(page, 'Hello from the stub')).toBeVisible()
    await openSession(page)
    await expect(runsOnOf(page)).toBeDisabled()
    await expect(runsOnOf(page)).toHaveValue('claude-code')
  })

  test('a new runtime chat shows Runs on with nothing chosen and Send blocked until a pick', {
    tag: ['@spec-24'],
  }, async ({ page, machine }) => {
    await machine(signedInMachine)
    await newRuntimeChat(page, 'Choose first', null)
    await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine])
    await page.getByRole('textbox', { name: 'Message' }).fill('Not yet')
    await expect(sendButtonOf(page)).toBeDisabled()
    await expect(mainOf(page)).toContainText('Choose where this chat runs to send')
    await chooseRunsOn(page, 'HQ runtime')
    await expect(sendButtonOf(page)).toBeEnabled()
  })

  test('before the owner chooses, another member waits and cannot send', { tag: ['@spec-24'] }, async ({
    page,
    browser,
    workerStack,
    machine,
  }) => {
    await machine(signedInMachine)
    await addParticipant(
      workerStack,
      await newRuntimeChat(page, 'Alice has not chosen', null),
      'member-bob',
      'prompter',
    )
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Alice has not chosen')
    await expect(runsOnChoiceOf(bobPage)).toHaveCount(0)
    await expect(mainOf(bobPage)).toContainText('Waiting for Alice to choose where this chat runs')
    await expect(sendButtonOf(bobPage)).toBeDisabled()
    await bobPage.context().close()
  })

  test('clicking outside the open chip closes it', { tag: ['@spec-24'] }, async ({ page }) => {
    await newRuntimeChat(page, 'Click away')
    await openSession(page)
    await mainOf(page).getByRole('heading', { level: 1, name: 'Click away' }).click()
    await expect(sessionOf(page)).toHaveCount(0)
  })

  test('Runs on follows the machine: its sign-ins, going offline and back, and its removal', {
    tag: ['@spec-24'],
  }, async ({ page, machine }) => {
    await machine(signedInMachine)
    await test.step('New chat offers only Channel and Runtime, even to a member with a machine', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      const dialog = page.getByRole('dialog', { name: 'New chat' })
      await expect(dialog.getByRole('radiogroup', { name: 'Chat type' }).getByRole('radio')).toHaveCount(2)
      await expect(dialog.getByRole('radio', { name: 'Channel' })).toBeVisible()
      await expect(dialog.getByRole('radio', { name: 'Runtime' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
    })
    await newRuntimeChat(page, 'Follows the machine', null)
    await test.step('only the signed-in tool of an online machine is offered, without a sign-in notice', async () => {
      await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine])
      await expect(runsOnChoiceOf(page)).not.toContainText('Sign in')
    })
    await chooseRunsOn(page, 'HQ runtime')
    for (const { step, query, options } of [
      {
        step: 'signed in to both tools',
        query: { signedIn: 'claude,codex' },
        options: [claudeOnMachine, codexOnMachine],
      },
      { step: 'offline', query: { online: 'false' }, options: [] },
      { step: 'back online', query: { online: 'true' }, options: [claudeOnMachine, codexOnMachine] },
      { step: 'signed in to neither tool', query: { signedIn: '' }, options: [] },
      { step: 'signed in to Claude Code again', query: { signedIn: 'claude' }, options: [claudeOnMachine] },
    ])
      await test.step(`a machine ${step} offers ${options.join(' and ') || 'HQ runtime only'}`, async () => {
        await machine(query)
        await openSession(page)
        await expect(runsOnOf(page).getByRole('option')).toHaveText(['HQ runtime', ...options])
        if (options.length) await expect(runsOnOf(page)).toBeEnabled()
        else await expectRunsOnLocked(page)
        await expect(sessionOf(page)).not.toContainText('Sign in')
      })
    await page.keyboard.press('Escape')
    await test.step('a removed machine offers no machine option', async () => {
      await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
      const machineSection = mainOf(page).getByRole('region', { name: 'My machine' })
      await machineSection.getByRole('button', { name: 'Remove' }).click()
      await page.getByRole('dialog', { name: 'Remove my machine' }).getByRole('button', { name: 'Remove' }).click()
      await expect(machineSection.getByRole('button', { name: 'Add my machine' })).toBeVisible()
      await openChat(page, 'Follows the machine')
      await openSession(page)
      await expectRunsOnLocked(page)
    })
  })

  test.describe('without a workspace host', () => {
    test.use({ runtimeHost: false })

    test('HQ runtime gives the no-host notice, then switching to My machine · Claude Code answers on the machine', {
      tag: ['@spec-24'],
    }, async ({ page, workerStack, machine }) => {
      const { id: machineId } = await machine(signedInMachine)
      await machine({ online: 'false' })
      const chatId = await newRuntimeChat(page, 'No host first')
      await sendMessage(page, 'First try')
      await expect(messageContaining(page, 'No runtime host is available')).toHaveCount(1)
      await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
      await machine({ online: 'true' })
      await openSession(page)
      await runsOnOf(page).selectOption({ label: claudeOnMachine })
      await expect(chipOf(page, 'any')).toHaveText('Claude Code · subscription')
      await page.keyboard.press('Escape')
      await sendMessage(page, 'Second try')
      await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(2)
      const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
      expect(runtime?.host_id).toBe(machineId)
      await expect.poll(async () => (await machine()).prompts).toEqual(['First try', 'Second try'])
    })
  })
})
