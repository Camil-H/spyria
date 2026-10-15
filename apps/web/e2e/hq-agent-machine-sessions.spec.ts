import {
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  type Page,
  runsOnChoiceOf,
  sendMessage,
  machineTest as test,
} from './fixtures'
import type { WorkerStack } from './stack'

const claudeCode = {
  name: 'Claude Code',
  signedIn: 'claude',
  models: ['Default (stub)', 'Large (stub)'],
  defaultModel: 'stub-default',
  large: { label: 'Large (stub)', id: 'stub-large' },
  forbidden: /ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|base_url/,
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

const chipOf = (page: Page) => mainOf(page).getByRole('button', { name: /^Claude Code · |^Codex · / })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const modelOf = (page: Page) => sessionOf(page).getByRole('combobox', { name: 'Model' })
const repliesWith = (page: Page, text: string | RegExp) => messageItemsOf(page).filter({ hasText: text })
const workingOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
const foldOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: /^Worked for .+ · 2 steps$/ })
const newSession = async (page: Page, tool: string) => {
  const chatId = await newRuntimeChat(page, `${tool} on my machine`, null)
  await expect(chipOf(page)).toHaveText(`${tool} · subscription`)
  return chatId
}
const startedCountOf = async (database: WorkerStack['database'], chatId: string) =>
  (
    await database.$client<{ count: string }[]>`
      select count(*) from events
      where chat_id = ${chatId} and payload->'event'->'update'->>'sessionUpdate' = 'session_started'`
  )[0]?.count
const sessionIdsOf = (database: WorkerStack['database'], chatId: string) =>
  database.$client<{ id: string }[]>`
    select distinct payload->'event'->'update'->>'sessionId' as id from events
    where chat_id = ${chatId} and payload->'event'->'update'->>'sessionUpdate' = 'session_started'`

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

for (const tool of tools) {
  const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }
  test.describe(tool.name, () => {
    test(`${tool.name} 18. choosing Runs on starts the session with no prompt: models listed, Runs on locked, a pick switches in place, the first prompt runs on it in the same session`, async ({
      page,
      workerStack,
      machine,
    }) => {
      await machine(machineOf)
      const chatId = await newSession(page, tool.name)
      await expect.poll(async () => (await machine()).conversations.length).toBe(1)
      expect((await machine()).prompts).toEqual([])
      await chipOf(page).click()
      await expect(modelOf(page).getByRole('option')).toHaveText(tool.models)
      await expect(sessionOf(page).getByText(`Runs on My machine · ${tool.name}`)).toBeVisible()
      await expect(sessionOf(page).getByRole('combobox', { name: 'Runs on' })).toHaveCount(0)
      await modelOf(page).selectOption({ label: tool.large.label })
      await expect(chipOf(page)).toHaveText(`${tool.name} · ${tool.large.label}`)
      await page.keyboard.press('Escape')
      await sendMessage(page, 'Hello')
      await expect(repliesWith(page, `[t1] Hello from the stub (model ${tool.large.id}`)).toBeVisible()
      const { conversations, prompts } = await machine()
      expect(conversations).toHaveLength(1)
      expect(conversations[0]?.agent).not.toHaveProperty('acp_model')
      expect(prompts).toHaveLength(1)
      expect(await startedCountOf(workerStack.database, chatId)).toBe('1')
      await test.step('the pick stays chosen in the Model list', async () => {
        await chipOf(page).click()
        await expect(modelOf(page)).toHaveValue(tool.large.id)
      })
    })
  })
}

test.describe('Claude Code', () => {
  const tool = claudeCode
  const machineOf = { owner: 'member-alice', signedIn: tool.signedIn }

  test(`${tool.name} 1. a turn streams text, folds its steps with final titles and the diff, ends once, and launches with no base URL and no key`, async ({
    page,
    workerStack,
    machine,
    release,
  }) => {
    await machine(machineOf)
    const chatId = await newSession(page, tool.name)
    await sendMessage(page, 'stub:tools stub:linger')
    await expect(repliesWith(page, '[t1]')).toBeVisible()
    await expect(workingOf(page)).toBeVisible()
    await release('linger')
    await expect(foldOf(page)).toBeVisible()
    await expect(workingOf(page)).toHaveCount(0)
    await foldOf(page).click()
    const edit = repliesWith(page, 'Edited app.ts +1 −1')
    await expect(edit).toHaveCount(1)
    await edit.getByRole('button').click()
    await expect(edit).toContainText('one')
    await expect(edit).toContainText('two')
    await expect(repliesWith(page, '$ npm test')).toContainText('exit 1')
    await expect(mainOf(page)).not.toContainText('$ Terminal')
    await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(1)

    await page.reload()
    await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(1)
    await expect(repliesWith(page, '[t1]')).toHaveCount(1)
    const answers = await workerStack.database.$client<{ body: string }[]>`
      select body from messages where chat_id = ${chatId} and kind = 'agent' order by seq`
    expect(answers.map((answer) => answer.body)).toEqual([
      '[t1]',
      'permission:allow-always',
      `Hello from the stub (model ${tool.defaultModel}, mode bypassPermissions).`,
    ])

    const { conversations } = await machine()
    expect(conversations).toHaveLength(1)
    const [launch] = conversations
    expect(launch?.agent).not.toHaveProperty('kind')
    expect(JSON.stringify(launch)).not.toMatch(tool.forbidden)
    expect(launch?.secrets).toEqual({})
  })

  test(`${tool.name} 3. Stop mid-command closes the turn as stopped, and the next prompt continues the same ACP session`, async ({
    page,
    workerStack,
    machine,
  }) => {
    await machine(machineOf)
    const chatId = await newSession(page, tool.name)
    await sendMessage(page, 'stub:long')
    await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toBeVisible()
    await mainOf(page).getByRole('button', { name: 'Stop' }).click()
    await expect(repliesWith(page, 'Stopped by Alice')).toHaveCount(1)
    await expect(workingOf(page)).toHaveCount(0)
    const [session] = await sessionIdsOf(workerStack.database, chatId)
    expect(session?.id).toBeTruthy()

    await sendMessage(page, 'Carry on')
    await expect(repliesWith(page, '[t2] Hello from the stub')).toHaveCount(1)
    await expect(mainOf(page)).not.toContainText('The agent started a new session')
    expect(await sessionIdsOf(workerStack.database, chatId)).toEqual([session])
    expect((await machine()).conversations).toHaveLength(1)
  })

  test('Claude Code 2. thinking streams live as Thinking… and folds to Thought for Ns', async ({
    page,
    machine,
    release,
  }) => {
    await machine(machineOf)
    await newSession(page, 'Claude Code')
    await sendMessage(page, 'stub:think stub:slow')
    await expect(repliesWith(page, 'Thinking…')).toHaveCount(1)
    await release('slow')
    await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(1)
    await expect(workingOf(page)).toHaveCount(0)
    await expect(repliesWith(page, 'Thinking…')).toHaveCount(0)
    await expect(repliesWith(page, /^Thought for .+s/)).toHaveCount(1)
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
    await chipOf(page).click()
    await expect(sessionOf(page).getByRole('combobox', { name: 'Runs on' })).toBeVisible()
    await page.keyboard.press('Escape')

    await machine({ online: 'true' })
    await sendMessage(page, 'Hello')
    await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible({ timeout: 45_000 })
    expect((await machine()).conversations).toHaveLength(1)
    expect(await startedCountOf(workerStack.database, chatId)).toBe('1')
  })

  test('24. with no workspace host online and one machine tool signed in, Runs on is chosen for the owner: no fieldset, session started', async ({
    page,
    machine,
  }) => {
    await machine({ owner: 'member-alice', signedIn: 'codex' })
    await newRuntimeChat(page, 'Only Codex', null)
    await expect(chipOf(page)).toHaveText('Codex · subscription')
    await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
    await expect.poll(async () => (await machine()).conversations.length).toBe(1)
    await chipOf(page).click()
    await expect(sessionOf(page).getByText('Runs on My machine · Codex')).toBeVisible()
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Hello')
    await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible()
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
    await expect(chipOf(page)).toHaveText('Claude Code · subscription')
    await expect(page.getByRole('group', { name: 'Runs on' })).toHaveCount(0)
    await expect.poll(async () => (await machine()).conversations.length).toBe(1)
    await chipOf(page).click()
    await expect(sessionOf(page).getByText('Runs on My machine · Claude Code')).toBeVisible()
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Hello')
    await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible()
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
      await expect(runsOnChoiceOf(page).getByRole('radio', { name: 'My machine · Claude Code' })).toBeVisible()
      await expect(mainOf(page).getByText('Choose where this chat runs to send')).toBeVisible()
      expect((await machine()).conversations).toHaveLength(0)
    })
  })
})
