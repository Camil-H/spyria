import { expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, test } from './fixtures'
import type { WorkerStack } from './stack'

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
