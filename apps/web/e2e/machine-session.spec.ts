import {
  chipOf,
  expect,
  foldOf,
  machineSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  newSession,
  type Page,
  panelOf,
  runsOnChipOf,
  runsOnChoiceOf,
  runsOnOf,
  sendMessage,
  sessionOf,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'
import type { WorkerStack } from './stack'

const claudeCode = {
  name: 'Claude Code',
  signedIn: 'claude',
  models: ['Default (stub)', 'Large (stub)'],
  large: { label: 'Large (stub)', id: 'stub-large' },
}
const tools = [
  claudeCode,
  {
    name: 'Codex',
    signedIn: 'codex',
    models: ['GPT stub', 'GPT stub mini'],
    large: { label: 'GPT stub mini', id: 'gpt-stub-mini' },
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
    test(`${tool.name} 18. choosing Runs on starts the session with no prompt: models listed, Runs on locked, a pick switches in place, the first prompt runs on it in the same session`, async ({
      page,
      machine,
    }) => {
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
        await expect(sessionOf(page).getByLabel('Effort')).toHaveCount(0)
      })
    })

    test(`${tool.name} f-2. an expired login shows one sign-in error with a link to the Profile, no agent message, and ${tool.name} signed out`, async ({
      page,
      machine,
    }) => {
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

  test(`${tool.name} 1. a turn streams text, folds its steps with final titles and the diff, and ends once`, async ({
    page,
    machine,
    release,
  }) => {
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

  test('Claude Code agent-steps 16. a plan shows as one checklist in its latest state and feeds the Plan tab', async ({
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

  test('Claude Code 20. a machine offline when Runs on is chosen starts nothing and Runs on stays changeable; once online the first prompt starts the session', async ({
    page,
    workerStack,
    machine,
  }) => {
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

  test('24. with no workspace host online and one machine tool signed in, Runs on is chosen for the owner: no fieldset, session started', async ({
    page,
    machine,
  }) => {
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

  test('25. with no workspace host online, a member’s only machine tool is chosen for them: no fieldset, session started', async ({
    page,
    machine,
  }) => {
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

    test('25. a member chooses between HQ runtime and their machine tool; nothing is chosen for them', async ({
      page,
      machine,
    }) => {
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
