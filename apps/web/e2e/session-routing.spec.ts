import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chipOf,
  expect,
  mainOf,
  messageItemsOf,
  modeRadioOf,
  newRuntimeChat,
  openChat,
  openSession,
  type Page,
  sendMessage,
  sessionOf,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs } from './stack'

const unchosen = 'Model chosen at first prompt'
const confident = (tier: string, effort = 'high') => ({ route: { tier, confidence: 'high', effort } })

const repliesOf = (page: Page) => messageItemsOf(page).filter({ hasText: agentReplyText })

const promptAndWait = async (page: Page, text: string, replies: number) => {
  await sendMessage(page, text)
  await expect(repliesOf(page)).toHaveCount(replies)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. before the first prompt the chip says the model is chosen at the first prompt', async ({ page }) => {
  await newRuntimeChat(page, 'Unrouted')
  await expect(chipOf(page, 'routed')).toHaveText(unchosen)
  await openChat(page, 'Research')
  await expect(chipOf(page, 'routed')).toHaveText(unchosen)
})

test('f-4. a member with only an OpenAI key gets an OpenAI model at the first prompt, never an Anthropic one', async ({
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'OpenAI')
  const chatId = await newRuntimeChat(bobPage, 'Bob on OpenAI')
  await expect(chipOf(bobPage, 'routed')).toHaveText(unchosen)
  await agentScript(chatId, { route: { tier: 'large', confidence: 'low', effort: 'medium' } })
  await promptAndWait(bobPage, 'Not sure how hard this is', 1)
  await expect(chipOf(bobPage, 'routed')).toHaveText('GPT-5 mini (medium)')
  await openSession(bobPage)
  await expect(sessionOf(bobPage).getByLabel('Main model')).toHaveValue('openai/gpt-5-mini')
  await expect(sessionOf(bobPage).getByRole('option', { name: /Opus|Sonnet|Haiku/ })).toHaveCount(0)
  await bobPage.context().close()
})

test('f-10. a member with an OpenRouter key gets a routed OpenRouter model that answers, the picker searches the full listing, and keys for Google, xAI, DeepSeek and Z.ai add their curated models', async ({
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'OpenRouter')
  const chatId = await newRuntimeChat(bobPage, 'Bob on OpenRouter')
  await agentScript(chatId, { route: { tier: 'large', confidence: 'low', effort: 'medium' } })
  await promptAndWait(bobPage, 'Route me through OpenRouter', 1)
  await expect(chipOf(bobPage, 'routed')).toHaveText('OpenRouter Sonnet 5.5 (medium)')

  await openSession(bobPage)
  const mainModel = sessionOf(bobPage).getByLabel('Main model')
  await expect(mainModel).toHaveValue('openrouter/anthropic/claude-sonnet-5.5')
  await expect(mainModel.getByRole('option')).toHaveText([
    'OpenRouter Opus 5.5',
    'OpenRouter Sonnet 5.5',
    'OpenRouter Haiku 5.5',
  ])
  await sessionOf(bobPage).getByLabel('Search all models').fill('kimi')
  await expect(mainModel.getByRole('option', { name: 'openrouter/moonshotai/kimi-k3', exact: true })).toHaveCount(1)
  await expect(mainModel.getByRole('option', { name: /fake|gpt|mistral/ })).toHaveCount(0)
  await mainModel.selectOption('openrouter/moonshotai/kimi-k3')
  await sessionOf(bobPage).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(bobPage, 'routed')).toHaveText('openrouter/moonshotai/kimi-k3 (medium)')
  await bobPage.keyboard.press('Escape')
  await promptAndWait(bobPage, 'Carry on with Kimi', 2)

  for (const provider of ['Google', 'xAI', 'DeepSeek', 'Z.ai']) await addLlmKey(bobPage, provider)
  await openChat(bobPage, 'Bob on OpenRouter')
  await openSession(bobPage)
  for (const name of ['Gemini Flash', 'Grok 4.3', 'DeepSeek V4 Flash', 'GLM-4.7'])
    await expect(sessionOf(bobPage).getByLabel('Main model').getByRole('option', { name, exact: true })).toHaveCount(1)
  await bobPage.context().close()
})

test('g-3. after a delegation, a curated switch and a searched switch each run the next turn on the new model with the earlier messages in its context, and the chip shows it', async ({
  page,
  agentScript,
}) => {
  const chatId = await newRuntimeChat(page, 'Switch keeps context')
  await agentScript(chatId, {
    steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } }],
    text: 'Main done.',
    delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
    subagents: { 'fake-small': { text: 'Two files.' } },
  })
  await sendMessage(page, 'The code word is PAPAYA, delegate the listing')
  await expect(messageItemsOf(page).filter({ hasText: 'Main done.' })).toHaveCount(1)
  await agentScript(chatId, { text: 'Context holds $userMessages prompts.' })

  await openSession(page)
  await sessionOf(page).getByLabel('Main model').selectOption('fake/fake-large')
  await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(page, 'routed')).toHaveText(/^Fake large( \(\w+\))?$/)
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Curated switch')
  await expect(messageItemsOf(page).filter({ hasText: 'Context holds 2 prompts.' })).toHaveCount(1)

  await openSession(page)
  await sessionOf(page).getByLabel('Search all models').fill('fake-model')
  await sessionOf(page).getByLabel('Main model').selectOption('fake/fake-model')
  await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(page, 'routed')).toHaveText(/^fake\/fake-model( \(\w+\))?$/)
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Searched switch')
  await expect(messageItemsOf(page).filter({ hasText: 'Context holds 3 prompts.' })).toHaveCount(1)
})

test('f-5. the session has no separate default model: before the first prompt nothing to pick, then the chip shows the main model', async ({
  page,
}) => {
  await newRuntimeChat(page, 'One model')
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toBeVisible()
  await expect(sessionOf(page).getByLabel('Default model')).toHaveCount(0)
  await expect(sessionOf(page).getByLabel('Main model')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await promptAndWait(page, 'Start on the main model', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake medium (medium)')
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Main model')).toHaveValue('fake/fake-medium')
  await expect(sessionOf(page).getByLabel('Default model')).toHaveCount(0)
})

test('5. a member reaching only a small model gets it, and is refused in a session on a model he cannot reach', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake-small')
  const bobChatId = await newRuntimeChat(bobPage, 'Bob small')
  await agentScript(bobChatId, confident('large'))
  await promptAndWait(bobPage, 'A big refactor please', 1)
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake small (high)')

  const aliceChatId = await newRuntimeChat(page, 'Alice large')
  await addParticipant(workerStack, aliceChatId, 'member-bob', 'prompter')
  await agentScript(aliceChatId, confident('large'))
  await promptAndWait(page, 'Redesign everything', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (high)')
  await openChat(bobPage, 'Alice large')
  await sendMessage(bobPage, 'Bob joins the large session')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'Bob joins the large session' })).toBeVisible()
  await expect(mainOf(bobPage)).toContainText('Your keys cannot reach Fake large; switch the model or add a key')
  await bobPage.context().close()
})

test('7 and 8. the manual switch warns about the reread, keeps the history and updates every viewer', async ({
  page,
  browser,
  workerStack,
}) => {
  await addParticipant(workerStack, await newRuntimeChat(page, 'Switched'), 'member-bob', 'reader')
  await promptAndWait(page, 'Start on the default', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake medium (medium)')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Switched')
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake medium (medium)')

  await openSession(page)
  await sessionOf(page).getByLabel('Main model').selectOption({ label: 'Fake large' })
  await expect(sessionOf(page)).toContainText(
    /The next reply rereads the whole conversation with Fake large \(about (\$\d+\.\d{2}|< \$0\.01)\)/,
  )
  await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (medium)')
  await expect(chipOf(bobPage, 'routed')).toHaveText('Fake large (medium)')
  await bobPage.context().close()

  await page.keyboard.press('Escape')
  await promptAndWait(page, 'Continue on large', 2)
  await expect(messageItemsOf(page).filter({ hasText: 'Start on the default' })).toBeVisible()
  await expect(mainOf(page)).not.toContainText('new session')
})

test('h-1. the effort sits between the main model and the subagents, and a change runs the next turn on the same model at that effort with the context kept', async ({
  page,
  agentScript,
}) => {
  const chatId = await newRuntimeChat(page, 'Effort')
  await promptAndWait(page, 'Start at medium', 1)
  await agentScript(chatId, { text: 'Effort $reasoningEffort with $userMessages prompts.' })
  await openSession(page)
  const labels = sessionOf(page).locator('label')
  await expect(labels.filter({ hasText: /^(Main model|Effort|Subagents)/ })).toHaveText([
    /^Main model/,
    /^Effort/,
    /^Subagents/,
  ])
  await expect(sessionOf(page).getByLabel('Effort')).toHaveValue('medium')
  await sessionOf(page).getByLabel('Effort').selectOption({ label: 'High' })
  await expect(chipOf(page, 'routed')).toHaveText('Fake medium (high)')
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Think harder')
  await expect(messageItemsOf(page).filter({ hasText: 'Effort high with 2 prompts.' })).toHaveCount(1)
})

test('9. the subagent policy toggles and persists', async ({ page }) => {
  await newRuntimeChat(page, 'Policy')
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Same as main' })
  await page.reload()
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('same_as_main')
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Auto' })
  await page.reload()
  await openSession(page)
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
})

test('11. with a decision model reachable, routing asks it and moves when it is confident', async ({
  page,
  agentScript,
}) => {
  await addLlmKey(page, 'Typesafe')
  const chatId = await newRuntimeChat(page, 'Decided')
  await agentScript(chatId, { route: { tier: 'large', confidence: 0.9, effort: 'high' } })
  await promptAndWait(page, 'Decide', 1)
  await expect(chipOf(page, 'routed')).toHaveText('Fake large (high)')
})

test('12. a member whose only key is a decision model is told to add an LLM key and cannot pick it', async ({
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Typesafe')
  await newRuntimeChat(bobPage, 'Bob decides')
  await openSession(bobPage)
  await expect(sessionOf(bobPage).getByRole('option', { name: 'Jev' })).toHaveCount(0)
  await bobPage.keyboard.press('Escape')
  await sendMessage(bobPage, 'Only a decision key')
  await expect(mainOf(bobPage)).toContainText('Bob has no LLM key in this workspace')
  await bobPage.context().close()
})

test('28-2. a prompter prompts on his own key, his session window is read-only and he gets no Stop', async ({
  page,
  browser,
  workerStack,
  agentScript,
  release,
}) => {
  const chatId = await newRuntimeChat(page, 'Bob prompts')
  await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
  await promptAndWait(page, 'Alice starts', 1)
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Bob prompts')
  await agentScript(chatId, { hold: 'answer' })
  await sendMessage(bobPage, 'Bob asks')
  await expect(workingIndicatorOf(bobPage)).toBeVisible()
  await expect(mainOf(page).getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(mainOf(bobPage).getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await release('answer')
  await expect(repliesOf(bobPage)).toHaveCount(2)
  await expect
    .poll(async () =>
      (await workerStack.database.$client`select prompter_id from model_calls where chat_id = ${chatId}`).map(
        ({ prompter_id }) => prompter_id,
      ),
    )
    .toContain('member-bob')

  await expect(modeRadioOf(bobPage, 'Plan')).toBeDisabled()
  await openSession(bobPage)
  await expect(sessionOf(bobPage).getByLabel('Main model')).toHaveValue('fake/fake-medium')
  for (const label of ['Main model', 'Search all models', 'Effort', 'Subagents'])
    await expect(sessionOf(bobPage).getByLabel(label)).toBeDisabled()
  await expect(sessionOf(bobPage).getByRole('button', { name: 'Switch' })).toHaveCount(0)
  await bobPage.context().close()
})
