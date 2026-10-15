import {
  addCredential,
  expect,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const research = 'chat-research'
const newSessionNotice = 'The agent started a new session; it does not remember earlier messages'
const itemsWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const chipOf = (page: Page) => mainOf(page).getByRole('button', { name: /· (auto|same as main)$/ })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const addKey = async (page: Page, provider: string) => {
  await openProfile(page)
  await addCredential(page, { provider, secret: `fake-key-${crypto.randomUUID()}` })
  await expect(llmSectionOf(page).getByRole('listitem').filter({ hasText: provider })).toBeVisible()
}
const conversationIdOf = async (workerStack: WorkerStack, chatId: string) =>
  String(
    (await workerStack.database.$client`select agent_conversation_id from runtimes where chat_id = ${chatId}`)[0]
      ?.agent_conversation_id,
  )
const sessionsStartedOf = async (workerStack: WorkerStack, chatId: string) =>
  workerStack.database.$client<{ sessionId: string; resumeFailed: boolean }[]>`
    select payload->'event'->'update'->>'sessionId' as "sessionId",
      (payload->'event'->'update'->>'resumeFailed')::boolean as "resumeFailed"
    from events where chat_id = ${chatId} and payload->'event'->'update'->>'sessionUpdate' = 'session_started'
    order by seq`
const routingRecordsOf = (workerStack: WorkerStack, chatId: string) =>
  workerStack.database.$client`
    select role, model, member_id from routing_decisions where chat_id = ${chatId} order by created_at`

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

for (const { provider, model, name } of [
  { provider: 'Anthropic', model: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { provider: 'OpenAI', model: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
  { provider: 'Mistral', model: 'mistral/mistral-medium-latest', name: 'Mistral Medium' },
])
  test(`8 and 9. a prompter with only an ${provider} key gets Pi: the command step streams its output, then the answer, and routing records the prompter`, async ({
    browser,
    workerStack,
    agentScript,
    release,
    heldCommand,
  }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addKey(bobPage, provider)
    const chatId = await newRuntimeChat(bobPage, `Bob on ${provider}`)
    const commandText = `echo one; ${heldCommand('command')}; echo two`
    await agentScript(chatId, { steps: [{ command: commandText }], text: `Answered on ${name}.` })
    await sendMessage(bobPage, 'Run it on Pi')

    const command = itemsWith(bobPage, commandText)
    await expect(command.getByRole('img', { name: 'Running' })).toBeVisible()
    await release('command')
    await expect(command.getByRole('img', { name: 'Succeeded' })).toBeVisible()
    await expect(itemsWith(bobPage, `Answered on ${name}.`)).toHaveCount(1)
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await expect(chipOf(bobPage)).toHaveText(`${name} (medium) · auto`)
    await command.getByRole('button', { name: commandText }).click()
    await expect(command).toContainText('one')
    await expect(command).toContainText('two')

    const launch = (await workerStack.fakeHost()).conversations.find(
      ({ agent }) => agent.acp_model === `${model.startsWith('anthropic/') ? 'hq-anthropic' : 'hq'}/${model}`,
    )
    expect(launch?.agent.acp_command.at(-1)).toMatch(/exec pi --mode rpc --no-themes$/)
    expect(await routingRecordsOf(workerStack, chatId)).toEqual([{ role: 'session', model, member_id: 'member-bob' }])
    await bobPage.context().close()
  })

test('10. a model switch to another provider mid-session runs the next reply on it in the same Pi session, at the routed effort', async ({
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addKey(bobPage, 'Anthropic')
  await addKey(bobPage, 'OpenAI')
  const chatId = await newRuntimeChat(bobPage, 'Bob switches provider')
  await agentScript(chatId, { route: { tier: 'large', confidence: 'high', effort: 'high' }, text: 'First on Opus.' })
  await sendMessage(bobPage, 'Start large')
  await expect(itemsWith(bobPage, 'First on Opus.')).toHaveCount(1)
  await expect(chipOf(bobPage)).toHaveText('Opus 5.5 (high) · auto')
  const conversationId = await conversationIdOf(workerStack, chatId)

  await chipOf(bobPage).click()
  await sessionOf(bobPage).getByLabel('Main model').selectOption({ label: 'GPT-5 mini' })
  await sessionOf(bobPage).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(bobPage)).toHaveText('GPT-5 mini (high) · auto')
  await bobPage.keyboard.press('Escape')
  await agentScript(chatId, { text: 'Then on GPT-5 mini.' })
  await sendMessage(bobPage, 'Now on OpenAI')
  await expect(itemsWith(bobPage, 'Then on GPT-5 mini.')).toHaveCount(1)
  await expect(itemsWith(bobPage, 'First on Opus.')).toHaveCount(1)
  await expect(mainOf(bobPage)).not.toContainText(newSessionNotice)

  expect(await conversationIdOf(workerStack, chatId)).toBe(conversationId)
  expect(await sessionsStartedOf(workerStack, chatId)).toHaveLength(1)
  const query = `metadata_chat=${chatId}&metadata_database=${workerStack.databaseName}&limit=100`
  await expect
    .poll(async () =>
      (
        (
          await workerStack.gateway<{ logs: { model: string; metadata: Record<string, string> | null }[] | null }>(
            `/api/logs?${query}`,
          )
        ).logs ?? []
      )
        .filter((log) => !log.metadata?.role)
        .map((log) => log.model)
        .toSorted(),
    )
    .toEqual(['claude-opus-5-5', 'gpt-5-mini'])
  await bobPage.context().close()
})

test('11. Stop during a command closes the turn as stopped, and a prompt queued behind it is answered next in the same Pi session', async ({
  page,
  workerStack,
  agentScript,
}) => {
  await openChat(page, 'Research')
  await agentScript(research, { steps: [{ command: 'sleep 30' }], text: 'Never shown.' })
  await sendMessage(page, 'Sleep for a while')
  await expect(itemsWith(page, 'sleep 30').getByRole('img', { name: 'Running' })).toBeVisible()
  const conversationId = await conversationIdOf(workerStack, research)
  await sendMessage(page, 'Carry on')
  await expect(itemsWith(page, 'Carry on')).toHaveCount(1)
  await agentScript(research, { text: 'Carried on.' })
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(itemsWith(page, 'Stopped by Alice')).toHaveCount(1)

  await expect(itemsWith(page, 'Carried on.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page).nth(0)).toContainText('Sleep for a while')
  await expect(messageItemsOf(page).nth(-3)).toContainText('Stopped by Alice')
  await expect(messageItemsOf(page).nth(-2)).toContainText('Carry on')
  await expect(messageItemsOf(page).nth(-1)).toContainText('Carried on.')
  await expect(mainOf(page)).not.toContainText('Never shown.')
  await expect(mainOf(page)).not.toContainText(newSessionNotice)
  expect(await conversationIdOf(workerStack, research)).toBe(conversationId)
  expect(await sessionsStartedOf(workerStack, research)).toHaveLength(1)
})

test('26. after an idle stop the next prompt restarts the runtime, loads the Pi session and no earlier message is duplicated', async ({
  page,
  workerStack,
  agentScript,
}) => {
  await openChat(page, 'Research')
  await agentScript(research, { text: 'Before the restart.' })
  await sendMessage(page, 'First prompt')
  await expect(itemsWith(page, 'Before the restart.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  const [firstSession] = await sessionsStartedOf(workerStack, research)
  await workerStack.database.$client`
    update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${research}`
  await workerStack.database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
    values ('workspace-acme', ${crypto.randomUUID()}, 'runtime.sweep', '{}'::jsonb, now(), 0, 'queued')`
  await expect(mainOf(page).getByRole('status', { name: 'Runtime' })).toHaveText('Sleeping')

  await agentScript(research, { text: 'After the restart.' })
  await sendMessage(page, 'Second prompt')
  await expect(itemsWith(page, 'After the restart.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(4)
  for (const [index, text] of ['First prompt', 'Before the restart.', 'Second prompt', 'After the restart.'].entries())
    await expect(messageItemsOf(page).nth(index)).toContainText(text)
  await expect(mainOf(page)).not.toContainText(newSessionNotice)
  expect(await sessionsStartedOf(workerStack, research)).toEqual([firstSession, firstSession])
  expect((await workerStack.database.$client`select state from runtimes where chat_id = ${research}`)[0]?.state).toBe(
    'running',
  )
})
