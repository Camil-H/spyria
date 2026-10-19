import { openPageAs, type WorkerStack } from '../stack'
import {
  addLlmKey,
  addParticipant,
  chipOf,
  chooseRunsOn,
  expect,
  machineSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  runsOnChoiceOf,
  runsOnOf,
  sendButtonOf,
  sendMessage,
  sessionOf,
  sidebarOf,
  signedInMachine,
  hostTest as test,
  urlOf,
} from './fixtures'

test.describe('Where a chat runs', () => {
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
  const machineOf = { owner: 'member-alice', signedIn: 'claude' }
  const expectRunsOnLockedLocal = async (page: Page) => {
    await expect(runsOnOf(page)).toBeDisabled()
    await expect(runsOnOf(page)).toHaveText('Local')
  }
  const startedCountOf = async (database: WorkerStack['database'], chatId: string) =>
    (
      await database.$client<{ count: string }[]>`
      select count(*) from events
      where chat_id = ${chatId} and payload->'event'->'update'->>'sessionUpdate' = 'session_started'`
    )[0]?.count
  const addMachine = async (page: Page) => {
    await openProfile(page)
    await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add my machine' })
    const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
    await dialog.getByRole('button', { name: 'Close' }).click()
    return command
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a chat owner, I leave a new runtime chat on HQ runtime and it runs on a workspace host with my key', {
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

  test('As a chat owner, I choose where my chat runs while another member does not see the choice, and Runs on locks once a conversation exists', {
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

  test('As a chat owner, I see Runs on with nothing chosen and Send blocked until I pick', {
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

  test('As a member of a chat whose owner has not chosen where it runs, I wait and cannot send', {
    tag: ['@spec-24'],
  }, async ({ page, browser, workerStack, machine }) => {
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

  test('As a member, I close the open session chip by clicking outside it', { tag: ['@spec-24'] }, async ({ page }) => {
    await newRuntimeChat(page, 'Click away')
    await openSession(page)
    await mainOf(page).getByRole('heading', { level: 1, name: 'Click away' }).click()
    await expect(sessionOf(page)).toHaveCount(0)
  })

  test('As a chat owner, I see Runs on follow my machine: its sign-ins, going offline and back, and its removal', {
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

  test.describe(() => {
    test.use({ runtimeHost: false })

    test('As a chat owner without a workspace host, I get the no-host notice on HQ runtime, then switching to my machine’s Claude Code answers there', {
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

  test.describe(() => {
    test.use({ runtimeHost: false })

    test('As a chat owner, my machine offline when I choose it starts nothing and Runs on stays changeable; once online my first prompt starts the session', {
      tag: ['@spec-25'],
    }, async ({ page, workerStack, machine }) => {
      await machine(machineOf)
      const release = Promise.withResolvers<void>()
      await page.route('**/api/mutate*', async (route) => {
        if (route.request().postData()?.includes('updateChatRouting')) await release.promise
        await route.continue()
      })
      const chatId = await newRuntimeChat(page, 'Offline when chosen', null)
      await machine({ online: 'false' })
      release.resolve()
      await expect
        .poll(
          async () =>
            (
              await workerStack.database.$client<{ state: string }[]>`
              select state from jobs where type = 'agent.start-session' and payload->>'chatId' = ${chatId}`
            )[0]?.state,
        )
        .toBe('done')
      expect((await machine()).conversations).toHaveLength(0)
      await expect(runsOnOf(page)).toBeEnabled()

      await machine({ online: 'true' })
      await sendMessage(page, 'Hello')
      await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible({ timeout: 45_000 })
      expect((await machine()).conversations).toHaveLength(1)
      await expect.poll(() => startedCountOf(workerStack.database, chatId)).toBe('1')
    })

    test('As a chat owner with no workspace host online and one machine tool signed in, I get Runs on chosen for me and the session started', {
      tag: ['@spec-25'],
    }, async ({ page, machine }) => {
      await machine({ owner: 'member-alice', signedIn: 'codex' })
      await newRuntimeChat(page, 'Only Codex', null)
      await expect(chipOf(page, 'harness')).toHaveText('Codex · subscription')
      await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
      await expect.poll(async () => (await machine()).conversations.length).toBe(1)
      await expectRunsOnLockedLocal(page)
      await sendMessage(page, 'Hello')
      await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
      expect((await machine()).conversations).toHaveLength(1)
    })

    test.describe(() => {
      test.use({ signedInAs: 'member-bob' })
      const bobMachine = { owner: 'member-bob', signedIn: 'claude' }

      test('As a member with no workspace host online, I get my only machine tool chosen for me and the session started', {
        tag: ['@spec-25'],
      }, async ({ page, machine }) => {
        await machine(bobMachine)
        await newRuntimeChat(page, 'Bob on Claude Code', null)
        await expect(chipOf(page, 'harness')).toHaveText('Claude Code · subscription')
        await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
        await expect.poll(async () => (await machine()).conversations.length).toBe(1)
        await expectRunsOnLockedLocal(page)
        await sendMessage(page, 'Hello')
        await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
        expect((await machine()).conversations).toHaveLength(1)
      })

      test.describe(() => {
        test.use({ runtimeHost: true })

        test('As a member with the workspace host online, I choose between HQ runtime and my machine tool, nothing chosen for me', {
          tag: ['@spec-25'],
        }, async ({ page, machine }) => {
          await machine(bobMachine)
          await newRuntimeChat(page, 'Bob chooses', null)
          await expect(runsOnChoiceOf(page).getByRole('radio')).toHaveCount(2)
          await expect(runsOnChoiceOf(page).getByRole('radio', { name: 'HQ runtime' })).toBeVisible()
          await expect(runsOnChoiceOf(page).getByRole('radio', { name: 'Local · Claude Code' })).toBeVisible()
          await expect(mainOf(page).getByText('Choose where this chat runs to send')).toBeVisible()
          expect((await machine()).conversations).toHaveLength(0)
        })
      })
    })
    test('As a chat owner with only my machine online, my ordinary runtime chats and another member’s wait with the no-host notice', {
      tag: ['@spec-20'],
    }, async ({ page, browser, workerStack, pair }) => {
      pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
      await expect(machineSectionOf(page)).toContainText('Online')

      await openChat(page, 'Research')
      await sendMessage(page, 'Run this on any host')
      await expect(messageItemsOf(page).filter({ hasText: 'No runtime host is available' })).toHaveCount(1)

      await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await addLlmKey(bobPage, 'Anthropic')
      await openChat(bobPage, 'Research')
      await sendMessage(bobPage, 'Bob tries too')
      await expect(messageItemsOf(bobPage).filter({ hasText: 'No runtime host is available' })).toHaveCount(2)
      await bobPage.context().close()
    })
  })
})
