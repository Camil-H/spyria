import { expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, sidebarOf, test } from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const agentReply = { timeout: 60_000 }
const metered = { timeout: 20_000 }
const researchChatId = 'chat-research'
const confidentSmall = { tier: 'small', confidence: 'high', effort: 'low' }
const subagentWork = { steps: [{ command: 'echo listing' }, { command: 'echo done' }], text: 'Two files.' }
const delegating = (answer: string, script: object) => ({
  steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } }],
  text: answer,
  ...script,
})
type GatewayLog = { model: string }

const groupOf = (page: Page, modelName: string) =>
  mainOf(page).getByRole('button', { name: new RegExp(`^Delegated to ${modelName} · 2 steps · `) })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const openSession = async (page: Page) => {
  await mainOf(page)
    .getByRole('button', { name: /Model chosen at first prompt|· (auto|same as main)$/ })
    .click()
  await expect(sessionOf(page)).toBeVisible()
}
const promptAndWait = async (page: Page, text: string, answer: string) => {
  await sendMessage(page, text)
  await expect(messageItemsOf(page).filter({ hasText: answer })).toBeVisible(agentReply)
}
const gatewayModelsOf = async (workerStack: WorkerStack, role: string, since: Date, count: number) => {
  const query = `metadata_chat=${researchChatId}&metadata_database=${workerStack.databaseName}&metadata_role=${role}&start_time=${since.toISOString()}`
  let models: string[] = []
  await expect
    .poll(async () => {
      models = (
        (await workerStack.gateway<{ logs: GatewayLog[] | null }>(`/api/logs?${query}&limit=100`)).logs ?? []
      ).map((log) => log.model)
      return models.length
    }, agentReply)
    .toBeGreaterThanOrEqual(count)
  return models
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Research')
})

test('5 and 13. a small task is delegated to the small model, shown as one collapsed group before the answer, and the chip lists both models', async ({
  page,
  workerStack,
  agentScript,
}) => {
  const startedAt = new Date()
  const answer = 'The subagent listed the files.'
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': subagentWork } }),
  )
  await promptAndWait(page, 'Delegate the listing', answer)
  const group = groupOf(page, 'Fake small')
  await expect(group).toBeVisible()
  await expect(messageItemsOf(page).last()).toContainText(answer)
  await expect(mainOf(page)).not.toContainText('$ echo listing')
  await group.click()
  const steps = page.getByRole('group', { name: 'Steps of Fake small' })
  await expect(steps).toContainText('$ echo listing')
  await expect(steps).toContainText('$ echo done')
  await expect(messageItemsOf(page).filter({ has: steps })).toContainText('Two files.')
  expect(new Set(await gatewayModelsOf(workerStack, 'delegate', startedAt, 3))).toEqual(new Set(['fake-small']))

  await openSession(page)
  const modelsUsed = sessionOf(page).getByRole('table', { name: 'Models used in this chat' })
  const callsOf = async (name: string) =>
    Number(
      (await modelsUsed
        .getByRole('row', { name: new RegExp(`^${name}`) })
        .getByRole('cell')
        .first()
        .textContent()) ?? 0,
    )
  await expect.poll(() => callsOf('Fake small'), metered).toBeGreaterThanOrEqual(5)
  await expect.poll(() => callsOf('Fake medium'), metered).toBeGreaterThanOrEqual(2)
  for (const name of ['Fake medium', 'Fake small']) {
    const [, tokens = '', cost = ''] = await modelsUsed
      .getByRole('row', { name: new RegExp(`^${name}`) })
      .getByRole('cell')
      .allTextContents()
    expect(Number(tokens.replaceAll(',', ''))).toBeGreaterThan(0)
    expect(cost).toMatch(/^(\$\d+\.\d{2}|< \$0\.01)$/)
  }
})

test('6. with the policy on Same as main, the subagent runs on the session model without a routing call', async ({
  page,
  workerStack,
  agentScript,
}) => {
  const startedAt = new Date()
  const answer = 'Done on the same model.'
  await openSession(page)
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Same as main' })
  await page.keyboard.press('Escape')
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-medium': subagentWork } }),
  )
  await promptAndWait(page, 'Delegate on the same model', answer)
  await expect(groupOf(page, 'Fake medium')).toBeVisible()
  expect(new Set(await gatewayModelsOf(workerStack, 'delegate', startedAt, 3))).toEqual(new Set(['fake-medium']))
  expect(await gatewayModelsOf(workerStack, 'router', startedAt, 1)).toEqual(['fake-small'])
})

test('9. a low-confidence or failed classification runs the subagent on the session model', async ({
  page,
  agentScript,
}) => {
  for (const [index, delegateRoute] of [{ tier: 'small', confidence: 'low', effort: 'low' }, 'fail'].entries()) {
    const answer = `Unsure answer ${index + 1}.`
    await agentScript(researchChatId, delegating(answer, { delegateRoute, subagents: { 'fake-medium': subagentWork } }))
    await promptAndWait(page, `Delegate while unsure ${index + 1}`, answer)
    await expect(groupOf(page, 'Fake medium')).toHaveCount(index + 1)
  }
  await expect(mainOf(page).getByRole('button', { name: /^Delegated to Fake small/ })).toHaveCount(0)
})

const delegatingTo = (model: string, answer: string, script: object) => ({
  steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small', model } }],
  text: answer,
  ...script,
})
const resuming = (answer: string, script: object) => ({
  steps: [
    { tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } },
    { tool: 'delegate', arguments: { task: 'List the project files', effort: 'small', resume: '$resume' } },
  ],
  text: answer,
  ...script,
})
const addKey = async (page: Page, provider: string) => {
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await llmSection.getByLabel('Provider').fill(provider)
  await llmSection.getByLabel('Secret').fill(`fake-key-${crypto.randomUUID()}`)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: provider })).toBeVisible()
}
const newRuntimeChat = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await dialog.getByText('Runtime', { exact: true }).click()
  await dialog.getByLabel('Chat name').fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  return page.url().split('/').at(-1) ?? ''
}

test('7. the main agent asks for fake-large and the subagent runs on it whatever the classifier says', async ({
  page,
  workerStack,
  agentScript,
}) => {
  const startedAt = new Date()
  const answer = 'Listed on the large model.'
  await agentScript(
    researchChatId,
    delegatingTo('fake-large', answer, { delegateRoute: confidentSmall, subagents: { 'fake-large': subagentWork } }),
  )
  await promptAndWait(page, 'Use fake-large to list the files', answer)
  await expect(groupOf(page, 'Fake large')).toBeVisible()
  expect(new Set(await gatewayModelsOf(workerStack, 'delegate', startedAt, 3))).toEqual(new Set(['fake-large']))
})

test('8. Bob asks for fake-large and gets fake-small, with the fallback line on the group', async ({
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addKey(bobPage, 'Fake-small')
  const bobChatId = await newRuntimeChat(bobPage, 'Bob delegates')
  const answer = 'Listed on what Bob can reach.'
  await agentScript(bobChatId, delegatingTo('fake-large', answer, { subagents: { 'fake-small': subagentWork } }))
  await promptAndWait(bobPage, 'Use fake-large to list the files', answer)
  await expect(groupOf(bobPage, 'Fake small')).toBeVisible()
  await expect(mainOf(bobPage)).toContainText("Fake large isn't reachable with Bob's keys; used Fake small")
  await bobPage.context().close()
})

test('10. a subagent failure answers with HQ’s error, the group shows failed, and the main agent goes on', async ({
  page,
  agentScript,
}) => {
  const answer = 'The subagent failed, I will do it myself.'
  const failing = { steps: [{ command: 'echo listing' }, { fail: 'Overloaded' }] }
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': failing } }),
  )
  await promptAndWait(page, 'Delegate a failing listing', answer)
  const group = mainOf(page).getByRole('button', { name: /^Delegated to Fake small · failed · / })
  await expect(group).toBeVisible()
  await expect(mainOf(page)).not.toContainText('The agent stopped with an error')
  await group.click()
  const steps = page.getByRole('group', { name: 'Steps of Fake small' })
  await expect(messageItemsOf(page).filter({ has: steps })).toContainText(
    'The subagent on Fake small stopped with an error',
  )
})

test('11. a long subagent task returns still running, then its result on resume, in one group with one answer', async ({
  page,
  agentScript,
}) => {
  const answer = 'The long listing is done.'
  const slowWork = { ...subagentWork, text: 'The slow listing found two files today.', wordDelayMilliseconds: 1_000 }
  await agentScript(
    researchChatId,
    resuming(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': slowWork } }),
  )
  await promptAndWait(page, 'Delegate a long listing', answer)
  await expect(groupOf(page, 'Fake small')).toHaveCount(1)
  await expect(mainOf(page).getByRole('button', { name: /^Used delegate/ })).toHaveCount(0)
  await groupOf(page, 'Fake small').click()
  const group = messageItemsOf(page).filter({ has: page.getByRole('group', { name: 'Steps of Fake small' }) })
  await expect(group).toContainText('The slow listing found two files today.')
  await expect(group).not.toContainText('is still running')
  await expect(messageItemsOf(page).filter({ hasText: answer })).toHaveCount(1)
})

test('12. stopping during a delegation stops the subagent, the group shows stopped, and the next prompt runs', async ({
  page,
  agentScript,
}) => {
  const longWork = {
    steps: [{ command: 'echo listing' }],
    text: 'one two three four five six seven eight nine ten',
    wordDelayMilliseconds: 2_000,
  }
  await agentScript(
    researchChatId,
    resuming('Never shown.', { delegateRoute: confidentSmall, subagents: { 'fake-small': longWork } }),
  )
  await sendMessage(page, 'Delegate a very long listing')
  await expect(mainOf(page).getByRole('button', { name: /^Delegating to Fake small/ })).toBeVisible(agentReply)
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(mainOf(page).getByRole('button', { name: /^Delegated to Fake small · stopped · 1 step/ })).toBeVisible(
    agentReply,
  )
  await expect(messageItemsOf(page).filter({ hasText: 'Stopped by Alice' })).toHaveCount(1)
  await agentScript(researchChatId, { text: 'Back to work.' })
  await promptAndWait(page, 'Carry on', 'Back to work.')
  await expect(mainOf(page)).not.toContainText('Never shown.')
})

test.describe('real Agent Server', () => {
  test.use({ agentServer: 'real' })
  test.describe.configure({ mode: 'default' })

  const delegationRowsOf = (workerStack: WorkerStack) =>
    workerStack.database.$client<{ status: string; conversation_id: string | null; model: string }[]>`
      select status, conversation_id, model from delegations where chat_id = ${researchChatId} order by created_at`

  test('14. a real sub-conversation runs the delegated task on the small model, grouped before the answer', async ({
    page,
    workerStack,
    agentScript,
  }) => {
    const answer = 'The real subagent listed the files.'
    await agentScript(
      researchChatId,
      delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': subagentWork } }),
    )
    await promptAndWait(page, 'Delegate the listing for real', answer)
    const group = groupOf(page, 'Fake small')
    await expect(group).toBeVisible()
    await expect(messageItemsOf(page).last()).toContainText(answer)
    await group.click()
    const steps = page.getByRole('group', { name: 'Steps of Fake small' })
    await expect(steps).toContainText('$ echo listing')
    await expect(steps).toContainText('$ echo done')
    await expect(messageItemsOf(page).filter({ has: steps })).toContainText('Two files.')
    const [delegation] = await delegationRowsOf(workerStack)
    expect(delegation).toMatchObject({ status: 'finished', model: 'fake/fake-small' })
    expect(delegation?.conversation_id).toBeTruthy()
  })

  test('15. stopping during a real delegation interrupts the subagent, the group shows stopped, and the next prompt runs', async ({
    page,
    workerStack,
    agentScript,
  }) => {
    const longWork = {
      steps: [{ command: 'echo listing' }],
      text: 'one two three four five six seven eight nine ten',
      wordDelayMilliseconds: 2_000,
    }
    await agentScript(
      researchChatId,
      delegating('Never shown.', { delegateRoute: confidentSmall, subagents: { 'fake-small': longWork } }),
    )
    await sendMessage(page, 'Delegate a very long listing for real')
    await expect(mainOf(page).getByRole('button', { name: /^Delegating to Fake small/ })).toBeVisible(agentReply)
    await expect
      .poll(
        async () =>
          (
            await workerStack.database.$client`
              select 1 from events where chat_id = ${researchChatId}
              and payload->'delegation' is not null and payload->'event'->'observation'->>'kind' = 'TerminalObservation'`
          ).length,
        agentReply,
      )
      .toBe(1)
    await mainOf(page).getByRole('button', { name: 'Stop' }).click()
    await expect(mainOf(page).getByRole('button', { name: /^Delegated to Fake small · stopped · 1 step/ })).toBeVisible(
      agentReply,
    )
    await expect(messageItemsOf(page).filter({ hasText: 'Stopped by Alice' })).toHaveCount(1)
    await agentScript(researchChatId, { text: 'Back to real work.' })
    await promptAndWait(page, 'Carry on for real', 'Back to real work.')
    await expect(mainOf(page)).not.toContainText('Never shown.')
    expect((await delegationRowsOf(workerStack)).map((row) => row.status)).toEqual(['stopped'])
  })

  test('16. a failing real subagent comes back as an error tool result and the group shows failed', async ({
    page,
    workerStack,
    agentScript,
  }) => {
    const answer = 'The real subagent failed, I will do it myself.'
    const failing = { steps: [{ command: 'echo listing' }, { fail: 'Overloaded' }] }
    await agentScript(
      researchChatId,
      delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': failing } }),
    )
    await promptAndWait(page, 'Delegate a failing listing for real', answer)
    await expect(mainOf(page).getByRole('button', { name: /^Delegated to Fake small · failed · / })).toBeVisible()
    const [observation] = await workerStack.database.$client<{ observation: { is_error: boolean } }[]>`
      select payload->'event'->'observation' as observation from events
      where chat_id = ${researchChatId} and payload->'event'->'observation'->>'kind' = 'MCPToolObservation'`
    expect(observation?.observation.is_error).toBe(true)
  })
})
