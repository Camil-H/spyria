import { openPageAs, type WorkerStack } from '../stack'
import {
  addParticipant,
  chipOf,
  expect,
  foldOf,
  hostsSectionOf,
  llmSectionOf,
  machineSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  newSession,
  openChat,
  openProfile,
  openSettings,
  type Page,
  panelOf,
  runsOnChipOf,
  runsOnChoiceOf,
  runsOnOf,
  sendMessage,
  serverUrl,
  sessionOf,
  sessionStarted,
  signedInMachine,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'

test.describe('Starting a session on my machine', () => {
  const claudeCode = {
    name: 'Claude Code',
    signedIn: 'claude',
    models: ['Default (stub)', 'Large (stub)'],
    large: { label: 'Large (stub)', id: 'stub-large' },
    efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    pickedEffort: 'max',
  }
  const tools = [
    claudeCode,
    {
      name: 'Codex',
      signedIn: 'codex',
      models: ['GPT stub', 'GPT stub mini'],
      large: { label: 'GPT stub mini', id: 'gpt-stub-mini' },
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      pickedEffort: 'high',
    },
  ]

  const modelOf = (page: Page) => sessionOf(page).getByRole('combobox', { name: 'Model' })
  const expectRunsOnLocked = async (page: Page) => {
    await expect(runsOnOf(page)).toBeDisabled()
    await expect(runsOnOf(page)).toHaveText('Local')
  }
  const startedCountOf = async (database: WorkerStack['database'], chatId: string) =>
    (
      await database.$client<{ count: string }[]>`
      select count(*) from events
      where chat_id = ${chatId} and payload->'event'->'update'->>'sessionUpdate' = 'session_started'`
    )[0]?.count

  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  for (const tool of tools) {
    const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }
    test.describe(tool.name, () => {
      test('choosing Runs on starts the session with no prompt: models listed, Runs on locked, a pick switches in place, the first prompt runs on it in the same session', {
        tag: ['@spec-25'],
      }, async ({ page, machine }) => {
        await machine(machineOf)
        await newSession(page, tool.name)
        await chipOf(page, 'harness').click()
        await expect(modelOf(page).getByRole('option')).toHaveText(tool.models)
        await expectRunsOnLocked(page)
        await modelOf(page).selectOption({ label: tool.large.label })
        await expect(chipOf(page, 'harness')).toHaveText(`${tool.name} · ${tool.large.label}`)
        await page.keyboard.press('Escape')
        await sendMessage(page, 'Hello')
        await expect(messageContaining(page, `[t1] Hello from the stub (model ${tool.large.id}`)).toBeVisible()
        await expect(mainOf(page)).not.toContainText('The agent started a new session')
        await test.step('f-6. the Runs on chip reads Local · Ready', async () => {
          await expect(runsOnOf(page)).toHaveText('Local')
          await expect(runsOnChipOf(page).getByRole('status', { name: 'Runtime' })).toHaveText('Ready')
          await expect(mainOf(page).getByRole('status', { name: 'Runtime' })).toHaveCount(1)
        })
        await test.step('the pick stays chosen in the Model list', async () => {
          await chipOf(page, 'harness').click()
          await expect(modelOf(page)).toHaveValue(tool.large.id)
          await expect(sessionOf(page).getByLabel('Effort')).toHaveValue(tool.efforts[0] ?? '')
        })
      })

      test('Effort lists the tool’s levels, a pick shows in the chip and the next prompt runs at it on the same session', {
        tag: ['@spec-25', '@stage-h2'],
      }, async ({ page, machine }) => {
        await machine(machineOf)
        await newSession(page, tool.name)
        await chipOf(page, 'harness').click()
        const effort = sessionOf(page).getByLabel('Effort')
        await expect(effort.getByRole('option')).toHaveText(tool.efforts)
        await effort.selectOption({ label: tool.pickedEffort })
        await expect(chipOf(page, 'harness')).toHaveText(`${tool.name} · subscription (${tool.pickedEffort})`)
        await page.keyboard.press('Escape')
        await sendMessage(page, 'stub:effort')
        await expect(messageContaining(page, `[t1] Effort ${tool.pickedEffort}.`)).toBeVisible()
        await expect(mainOf(page)).not.toContainText('The agent started a new session')
        expect((await machine()).conversations).toHaveLength(1)
        await chipOf(page, 'harness').click()
        await expect(effort).toHaveValue(tool.pickedEffort)
      })

      test(`an expired login shows one sign-in error with a link to the Profile, no agent message, and ${tool.name} signed out`, {
        tag: ['@spec-25', '@stage-f'],
      }, async ({ page, machine }) => {
        await machine(machineOf)
        await newSession(page, tool.name)
        await sendMessage(page, 'stub:auth-expired')
        const banner = mainOf(page).getByRole('alert')
        await expect(banner).toHaveText(`Authentication required — sign in to ${tool.name} again Open profile`)
        await expect(workingIndicatorOf(page)).toHaveCount(0)
        await expect(banner).toHaveCount(1)
        await expect(mainOf(page)).not.toContainText('OAuth session expired')
        await expect(mainOf(page)).not.toContainText('The agent stopped with an error')
        await page.reload()
        await expect(mainOf(page).getByRole('alert')).toHaveCount(1)
        await expect(mainOf(page)).not.toContainText('OAuth session expired')
        await banner.getByRole('link', { name: 'Open profile' }).click()
        await expect(page).toHaveURL(/\/profile#my-machine$/)
        await expect(machineSectionOf(page)).toBeInViewport()
        await expect(machineSectionOf(page).getByRole('button', { name: `Use ${tool.name}` })).toBeVisible()
        await expect(machineSectionOf(page).getByRole('button', { name: `${tool.name} connected` })).toHaveCount(0)
      })
    })
  }

  test.describe('Claude Code', () => {
    const tool = claudeCode
    const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }

    test('a turn streams text, folds its steps with final titles and the diff, and ends once', {
      tag: ['@spec-25', '@smoke'],
    }, async ({ page, machine, release }) => {
      await machine(machineOf)
      await newSession(page, tool.name)
      await sendMessage(page, 'stub:tools stub:linger')
      await expect(messageContaining(page, '[t1]')).toBeVisible()
      await expect(workingIndicatorOf(page)).toBeVisible()
      await release('linger')
      await expect(foldOf(page, 2)).toBeVisible()
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await test.step('text streamed before the steps stays before them, the answer after them', async () => {
        await expect(messageItemsOf(page)).toHaveCount(4)
        await expect(messageItemsOf(page).nth(1)).toContainText('[t1]')
        await expect(messageItemsOf(page).nth(2)).toContainText(/^Worked for .+ · 2 steps$/)
        await expect(messageItemsOf(page).nth(3)).toContainText('Hello from the stub')
        await expect(messageItemsOf(page).nth(3)).not.toContainText('[t1]')
      })
      await foldOf(page, 2).click()
      const edit = messageContaining(page, 'Edited app.ts +1 −1')
      await expect(edit).toHaveCount(1)
      await edit.getByRole('button').click()
      await expect(edit).toContainText('one')
      await expect(edit).toContainText('two')
      await expect(messageContaining(page, '$ npm test')).toContainText('exit 1')
      await expect(mainOf(page)).not.toContainText('$ Terminal')
      await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(1)

      await page.reload()
      await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(1)
      await expect(messageContaining(page, '[t1]')).toHaveCount(1)
    })

    test('a plan shows as one checklist in its latest state and feeds the Plan tab', { tag: ['@spec-10'] }, async ({
      page,
      machine,
    }) => {
      await machine(machineOf)
      await newSession(page, 'Claude Code')
      await sendMessage(page, 'stub:plan-progress')

      await expect(workingIndicatorOf(page)).toHaveCount(0)
      const checklist = mainOf(page).getByRole('group', { name: 'Plan' })
      await expect(checklist).toHaveCount(1)
      await expect(checklist.getByRole('checkbox', { name: 'Fix the totals' })).toBeChecked()
      await expect(checklist.getByRole('checkbox', { name: 'Reproduce the bug' })).toBeChecked()
      await panelOf(page).getByRole('tab', { name: 'Plan', exact: true }).click()
      await expect(panelOf(page).getByRole('tabpanel').getByRole('listitem')).toHaveCount(2)
      await expect(panelOf(page).getByRole('tabpanel')).toContainText('Fix the totals')
      await expect(panelOf(page).getByRole('tabpanel')).not.toContainText('In progress')
    })

    test('a machine offline when Runs on is chosen starts nothing and Runs on stays changeable; once online the first prompt starts the session', {
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

    test('with no workspace host online and one machine tool signed in, Runs on is chosen for the owner: no fieldset, session started', {
      tag: ['@spec-25'],
    }, async ({ page, machine }) => {
      await machine({ owner: 'member-alice', signedIn: 'codex' })
      await newRuntimeChat(page, 'Only Codex', null)
      await expect(chipOf(page, 'harness')).toHaveText('Codex · subscription')
      await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
      await expect.poll(async () => (await machine()).conversations.length).toBe(1)
      await expectRunsOnLocked(page)
      await sendMessage(page, 'Hello')
      await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
      expect((await machine()).conversations).toHaveLength(1)
    })
  })

  test.describe('a member', () => {
    test.use({ signedInAs: 'member-bob' })
    const bobMachine = { owner: 'member-bob', signedIn: 'claude' }

    test('with no workspace host online, a member’s only machine tool is chosen for them: no fieldset, session started', {
      tag: ['@spec-25'],
    }, async ({ page, machine }) => {
      await machine(bobMachine)
      await newRuntimeChat(page, 'Bob on Claude Code', null)
      await expect(chipOf(page, 'harness')).toHaveText('Claude Code · subscription')
      await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
      await expect.poll(async () => (await machine()).conversations.length).toBe(1)
      await expectRunsOnLocked(page)
      await sendMessage(page, 'Hello')
      await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
      expect((await machine()).conversations).toHaveLength(1)
    })

    test.describe('with the workspace host online', () => {
      test.use({ runtimeHost: true })

      test('a member chooses between HQ runtime and their machine tool; nothing is chosen for them', {
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
})

test.describe('Prompting a session on my machine', () => {
  const machineOption = 'Local · Claude Code'
  const codexOption = 'Local · Codex'
  const codexMachine = { owner: 'member-alice', signedIn: 'codex' }
  const tools = [
    { name: 'Claude Code', login: 'claude' },
    { name: 'Codex', login: 'codex' },
  ]

  const newMachineSession = async (page: Page, name: string, option = machineOption) => {
    const chatId = await newRuntimeChat(page, name, option)
    await expect(chipOf(page, 'any')).toHaveText(`${option.replace('Local · ', '')} · subscription`)
    return chatId
  }
  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  for (const tool of tools) {
    test(`the owner prompts a ${tool.name} session on their machine and gets the answer, unmetered`, {
      tag: ['@spec-20'],
    }, async ({ page, machine }) => {
      await machine({ owner: 'member-alice', signedIn: tool.login })
      await newMachineSession(page, `${tool.name} on my laptop`, `Local · ${tool.name}`)
      await sendMessage(page, 'Hello from my laptop')
      await expect(messageContaining(page, 'Hello from the stub')).toBeVisible()
      const sidePanel = page.getByRole('region', { name: 'Side panel' })
      await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
      await expect(sidePanel).toContainText('Subscription session on your machine, not metered by HQ')
    })

    test(`a prompt while the machine is signed out of ${tool.name} shows its sign-in notice and reaches no agent`, {
      tag: ['@spec-20'],
    }, async ({ page, workerStack, machine }) => {
      await machine({ owner: 'member-alice', signedIn: tool.login })
      await sessionStarted(
        workerStack,
        await newMachineSession(page, `${tool.name} signed out`, `Local · ${tool.name}`),
      )
      await machine({ signedIn: '' })
      await sendMessage(page, 'Answer without a sign-in')
      await expect(
        messageContaining(
          page,
          `Sign in to ${tool.name} on your machine: docker exec -it hq-host hq-host login ${tool.login}`,
        ),
      ).toHaveCount(1)
      expect((await machine()).prompts).toEqual([])
    })
  }

  test('another member reads the session and the answer, and their prompt gets the owner-only notice', {
    tag: ['@spec-20'],
  }, async ({ page, browser, workerStack, machine }) => {
    await machine(signedInMachine)
    await addParticipant(workerStack, await newMachineSession(page, 'Shared laptop session'), 'member-bob', 'prompter')
    await sendMessage(page, 'Alice prompts the laptop')
    await expect(messageContaining(page, 'Hello from the stub')).toBeVisible()

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Shared laptop session')
    await expect(messageContaining(bobPage, 'Hello from the stub')).toBeVisible()
    await sendMessage(bobPage, 'Bob tries the laptop')
    await expect(messageContaining(bobPage, 'Only the owner prompts a session on their machine')).toHaveCount(1)
    await expect(messageContaining(page, 'Only the owner prompts a session on their machine')).toHaveCount(1)
    await bobPage.context().close()
  })

  test('a prompt while the machine is offline waits with "Your machine is offline" and is answered once it is back', {
    tag: ['@spec-20', '@slow'],
  }, async ({ page, workerStack, machine }) => {
    await machine(signedInMachine)
    await sessionStarted(workerStack, await newMachineSession(page, 'Laptop goes away'))
    await machine({ online: 'false' })
    await sendMessage(page, 'Wait for my laptop')
    await expect(messageContaining(page, 'Your machine is offline')).toHaveCount(1)
    await machine({ online: 'true' })
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()

    await machine({ online: 'false' })
    await sendMessage(page, 'Wait for my laptop again')
    await expect(messageContaining(page, 'Your machine is offline')).toHaveCount(2)
    await machine({ online: 'true' })
    await expect(messageContaining(page, '[t2] Hello from the stub')).toBeVisible()
    expect((await machine()).prompts).toEqual(['Wait for my laptop', 'Wait for my laptop again'])
  })

  test.describe('Codex on a ChatGPT plan', () => {
    test('a command pending with no input shows the real command and no spinner once completed, and a read shows its path', {
      tag: ['@spec-21'],
    }, async ({ page, machine, release }) => {
      await machine(codexMachine)
      await newMachineSession(page, 'Real steps', codexOption)
      await sendMessage(page, 'stub:read stub:tools stub:linger')
      await expect(messageContaining(page, '$ npm test').getByRole('img', { name: 'Failed' })).toBeVisible()
      await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
      await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
      await release('linger')
      await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
      await messageItemsOf(page)
        .getByRole('button', { name: /^Worked for .+ · 3 steps$/ })
        .click()
      await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
      const command = messageContaining(page, '$ npm test')
      await expect(command.getByRole('img', { name: 'Failed' })).toBeVisible()
      await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toHaveCount(0)
      await expect(mainOf(page)).not.toContainText('$ Terminal')
      await expect(mainOf(page)).not.toContainText('Read File')
    })
  })
})

test.describe('An admin turning machine sessions off', () => {
  const switchName = 'Members can run sessions on their own machine'
  const turnedOffNotice = "Your workspace turned off sessions on members' machines"
  const sessionNotice = "Sessions on members' machines are turned off for this workspace"

  const switchOf = (page: Page) => hostsSectionOf(page).getByRole('switch', { name: switchName })

  const setLocalSessions = async (page: Page, isOn: boolean) => {
    await openSettings(page, 'Connect runtime')
    await expect(switchOf(page)).toHaveAttribute('aria-checked', String(!isOn))
    await switchOf(page).click()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', String(isOn))
  }
  const openNewChat = async (page: Page) => {
    await page.getByRole('button', { name: 'New chat' }).click()
    return page.getByRole('dialog', { name: 'New chat' })
  }
  const tokenOf = async (workerStack: WorkerStack, user: string) =>
    (
      await (
        await fetch(`${serverUrl}/test/token?db=${workerStack.databaseName}&user=${user}&workspace=workspace-acme`, {
          method: 'POST',
        })
      ).json()
    ).token as string

  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('the admin turns sessions on members’ machines off: My machine shows the notice with no Add my machine and no Use Claude Code or Use Codex, a refused add, no My machine option in the chip', {
    tag: ['@spec-22'],
  }, async ({ page, browser, workerStack, machine }) => {
    await setLocalSessions(page, false)

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openProfile(bobPage)
    await expect(machineSectionOf(bobPage)).toContainText(turnedOffNotice)
    await expect(machineSectionOf(bobPage).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)
    await expect(machineSectionOf(bobPage).getByRole('button', { name: /Use Claude Code|Use Codex/ })).toHaveCount(0)
    await expect(machineSectionOf(bobPage)).not.toContainText('docker')
    await expect(llmSectionOf(bobPage).getByRole('button', { name: /Claude Code|Codex/ })).toHaveCount(0)

    const response = await fetch(`${serverUrl}/api/runtime-hosts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenOf(workerStack, 'member-bob')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ personal: true }),
    })
    expect(response.status).toBe(403)
    expect((await response.json()).message).toBe(turnedOffNotice)
    expect(
      await workerStack.database
        .$client`select 1 from runtime_hosts where owner_id = 'member-bob' and removed_at is null`,
    ).toHaveLength(0)

    await machine({ owner: 'member-bob', signedIn: 'claude' })
    await expect(machineSectionOf(bobPage)).toContainText('Online')
    await expect(machineSectionOf(bobPage).getByRole('button', { name: 'Remove' })).toBeVisible()
    const dialog = await openNewChat(bobPage)
    await expect(dialog.getByRole('radiogroup', { name: 'Chat type' }).getByRole('radio')).toHaveCount(2)
    await dialog.getByRole('radio', { name: 'Runtime' }).check()
    await dialog.getByRole('textbox', { name: 'Chat name' }).fill('Bob while off')
    await dialog.getByRole('button', { name: 'Confirm' }).click()
    await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Bob while off' })).toBeVisible()
    await expect(runsOnChoiceOf(bobPage)).toHaveCount(0)
    await expect(chipOf(bobPage, 'routed')).toHaveText('Model chosen at first prompt')
    const runsOn = mainOf(bobPage).getByRole('combobox', { name: 'Runs on' })
    await expect(runsOn).toBeDisabled()
    await expect(runsOn).toHaveValue('runtime')
    await bobPage.context().close()
  })

  test('an existing machine session answers prompts with the notice while it is off, and again once it is back on', {
    tag: ['@spec-22'],
  }, async ({ page, machine }) => {
    await machine({ owner: 'member-alice', signedIn: 'claude' })
    await newRuntimeChat(page, 'Laptop switch', 'Local · Claude Code')
    await expect(mainOf(page).getByRole('button', { name: 'Claude Code · subscription' })).toBeVisible()
    await sendMessage(page, 'Before the switch')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)

    await setLocalSessions(page, false)
    await openChat(page, 'Laptop switch')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    await sendMessage(page, 'While it is off')
    await expect(messageContaining(page, sessionNotice)).toHaveCount(1)
    expect((await machine()).prompts).toEqual(['Before the switch'])

    await setLocalSessions(page, true)
    await openChat(page, 'Laptop switch')
    await sendMessage(page, 'Back on')
    await expect(messageContaining(page, '[t2] Hello from the stub')).toBeVisible()
    expect((await machine()).prompts).toEqual(['Before the switch', 'Back on'])
    await expect(messageContaining(page, sessionNotice)).toHaveCount(1)
  })
})
