import { openPageAs } from '../stack'
import {
  addParticipant,
  chipOf,
  expect,
  expectRunsOnLockedLocal,
  mainOf,
  messageContaining,
  newMachineSession,
  newSession,
  openChat,
  type Page,
  runsOnOf,
  runsOnStatusOf,
  sendMessage,
  sessionOf,
  sessionStarted,
  signedInMachine,
  machineTest as test,
} from './fixtures'

test.describe('Machine sessions', () => {
  const claudeCode = {
    name: 'Claude Code',
    signedIn: 'claude-code',
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

  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  for (const tool of tools) {
    const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }

    test(`As a member, choosing ${tool.name} on my machine starts the session with no prompt: its models listed, Runs on locked, a pick switching in place and my first prompt running on it in the same session, on my subscription, unmetered`, {
      tag: ['@spec-20', '@spec-25', ...(tool.name === 'Claude Code' ? ['@smoke'] : [])],
    }, async ({ page, machine }) => {
      await machine(machineOf)
      await newSession(page, tool.name)
      await chipOf(page, 'harness').click()
      await expect(modelOf(page).getByRole('option')).toHaveText(tool.models)
      await expectRunsOnLockedLocal(page)
      await modelOf(page).selectOption({ label: tool.large.label })
      await expect(chipOf(page, 'harness')).toHaveText(`${tool.name} · ${tool.large.label}`)
      await page.keyboard.press('Escape')
      await sendMessage(page, 'Hello')
      await expect(messageContaining(page, `[t1] Hello from the stub (model ${tool.large.id}`)).toBeVisible()
      await expect(mainOf(page)).not.toContainText('The agent started a new session')
      await test.step('the Runs on chip reads Local · Ready', async () => {
        await expect(runsOnOf(page)).toHaveText('Local')
        await expect(runsOnStatusOf(page)).toHaveText('Ready')
        await expect(mainOf(page).getByRole('status', { name: 'Runtime' })).toHaveCount(1)
      })
      await test.step('the pick stays chosen in the Model list', async () => {
        await chipOf(page, 'harness').click()
        await expect(modelOf(page)).toHaveValue(tool.large.id)
        await expect(sessionOf(page).getByLabel('Effort')).toHaveValue(tool.efforts[0] ?? '')
      })
      await page.keyboard.press('Escape')
      const sidePanel = page.getByRole('region', { name: 'Side panel' })
      await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
      await expect(sidePanel).toContainText('Subscription session on your machine, not metered by Spyria')
    })

    test(`As a member, I pick an effort among ${tool.name}’s levels: it shows in the chip and my next prompt runs at it on the same session`, {
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
  }

  test('As another member of a session on someone’s machine, I read it and its answers, and my prompt gets the owner-only notice', {
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

  test('As a member, my prompt while my machine is offline waits with "Your machine is offline" and is answered once it is back', {
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
})
