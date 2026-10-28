import { openPageAs } from '../stack'
import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chipOf,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openSession,
  type Page,
  sendMessage,
  sessionOf,
  test,
} from './fixtures'

const unchosen = 'Model chosen at first prompt'
const confident = (tier: string, effort = 'high') => ({ route: { tier, confidence: 'high', effort } })

const repliesOf = (page: Page) => messageItemsOf(page).filter({ hasText: agentReplyText })

const promptAndWait = async (page: Page, text: string, replies: number) => {
  await sendMessage(page, text)
  await expect(repliesOf(page)).toHaveCount(replies)
}

test.describe('Models', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a prompter, I see that the model is chosen at my first prompt until I send it', {
    tag: ['@spec-15'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Unrouted')
    await expect(chipOf(page, 'routed')).toHaveText(unchosen)
    await openChat(page, 'Research')
    await expect(chipOf(page, 'routed')).toHaveText(unchosen)
  })

  test('As a member with only an OpenAI key, I get an OpenAI model at my first prompt, never an Anthropic one', {
    tag: ['@spec-25', '@stage-f'],
  }, async ({ browser, workerStack, agentScript }) => {
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

  test('As a member with an OpenRouter key, I get a routed OpenRouter model that answers, search the full listing, and keys for Google, xAI, DeepSeek and Z.ai add their curated models', {
    tag: ['@spec-25', '@stage-f'],
  }, async ({ browser, workerStack, agentScript }) => {
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
    await expect(mainModel.getByRole('option', { name: /grok|gpt|mistral/ })).toHaveCount(0)
    await mainModel.selectOption('openrouter/moonshotai/kimi-k3')
    await sessionOf(bobPage).getByRole('button', { name: 'Switch' }).click()
    await expect(chipOf(bobPage, 'routed')).toHaveText('openrouter/moonshotai/kimi-k3 (medium)')
    await bobPage.keyboard.press('Escape')
    await promptAndWait(bobPage, 'Carry on with Kimi', 2)

    for (const provider of ['Google', 'xAI', 'DeepSeek', 'Z.ai']) await addLlmKey(bobPage, provider)
    await openChat(bobPage, 'Bob on OpenRouter')
    await openSession(bobPage)
    for (const name of ['Gemini Flash', 'Grok 4.3', 'DeepSeek V4 Flash', 'GLM-4.7'])
      await expect(sessionOf(bobPage).getByLabel('Main model').getByRole('option', { name, exact: true })).toHaveCount(
        1,
      )
    await bobPage.context().close()
  })

  test('As a prompter, I switch the model after a delegation, curated or searched, and the next turn runs on it with the earlier messages in its context', {
    tag: ['@spec-25', '@stage-g'],
  }, async ({ page, agentScript }) => {
    const chatId = await newRuntimeChat(page, 'Switch keeps context')
    await agentScript(chatId, {
      steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } }],
      text: 'Main done.',
      delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
      subagents: { 'mistral-small-latest': { text: 'Two files.' } },
    })
    await sendMessage(page, 'The code word is PAPAYA, delegate the listing')
    await expect(messageItemsOf(page).filter({ hasText: 'Main done.' })).toHaveCount(1)
    await agentScript(chatId, { text: 'Context holds $userMessages prompts.' })

    await openSession(page)
    await sessionOf(page).getByLabel('Main model').selectOption('mistral/mistral-large-latest')
    await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
    await expect(chipOf(page, 'routed')).toHaveText(/^Mistral Large( \(\w+\))?$/)
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Curated switch')
    await expect(messageItemsOf(page).filter({ hasText: 'Context holds 2 prompts.' })).toHaveCount(1)

    await openSession(page)
    await sessionOf(page).getByLabel('Search all models').fill('codestral-latest')
    await sessionOf(page).getByLabel('Main model').selectOption('mistral/codestral-latest')
    await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
    await expect(chipOf(page, 'routed')).toHaveText(/^mistral\/codestral-latest( \(\w+\))?$/)
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Searched switch')
    await expect(messageItemsOf(page).filter({ hasText: 'Context holds 3 prompts.' })).toHaveCount(1)
  })

  test('As a prompter, I find no separate default model: nothing to pick before the first prompt, then the chip shows the main model', {
    tag: ['@spec-25', '@stage-f'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'One model')
    await openSession(page)
    await expect(sessionOf(page).getByLabel('Subagents')).toBeVisible()
    await expect(sessionOf(page).getByLabel('Default model')).toHaveCount(0)
    await expect(sessionOf(page).getByLabel('Main model')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await promptAndWait(page, 'Start on the main model', 1)
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Medium (medium)')
    await openSession(page)
    await expect(sessionOf(page).getByLabel('Main model')).toHaveValue('mistral/mistral-medium-latest')
    await expect(sessionOf(page).getByLabel('Default model')).toHaveCount(0)
  })

  test('As a member whose keys reach another provider, I get its model, and I am refused in a session on a model my keys cannot reach', {
    tag: ['@spec-15'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'xAI')
    const bobChatId = await newRuntimeChat(bobPage, 'Bob on xAI')
    await agentScript(bobChatId, confident('large'))
    await promptAndWait(bobPage, 'A big refactor please', 1)
    await expect(chipOf(bobPage, 'routed')).toHaveText('Grok 4.7 (high)')

    const aliceChatId = await newRuntimeChat(page, 'Alice large')
    await addParticipant(workerStack, aliceChatId, 'member-bob', 'prompter')
    await agentScript(aliceChatId, confident('large'))
    await promptAndWait(page, 'Redesign everything', 1)
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Large (high)')
    await openChat(bobPage, 'Alice large')
    await sendMessage(bobPage, 'Bob joins the large session')
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Bob joins the large session' })).toBeVisible()
    await expect(mainOf(bobPage)).toContainText('Your keys cannot reach Mistral Large; switch the model or add a key')
    await bobPage.context().close()
  })

  test('As a prompter, I see how full the agent’s context is next to the model once it has answered', {
    tag: ['@spec-15'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Context')
    const context = mainOf(page).getByRole('img', { name: /^Context: / })
    await expect(context).toHaveCount(0)
    await promptAndWait(page, 'How full are you?', 1)
    await expect(context).toHaveAccessibleName(/^Context: (\d+% full, 2 of [\d,]+|2) tokens$/)
  })

  test('As a prompter, I switch the model by hand: I am warned about the reread, the history stays and every viewer sees the new model', {
    tag: ['@spec-15', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    await addParticipant(workerStack, await newRuntimeChat(page, 'Switched'), 'member-bob', 'reader')
    await promptAndWait(page, 'Start on the default', 1)
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Medium (medium)')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Switched')
    await expect(chipOf(bobPage, 'routed')).toHaveText('Mistral Medium (medium)')

    await openSession(page)
    await sessionOf(page).getByLabel('Main model').selectOption({ label: 'Mistral Large' })
    await expect(sessionOf(page)).toContainText(
      /The next reply rereads the whole conversation with Mistral Large \(about (\$\d+\.\d{2}|< \$0\.01)\)/,
    )
    await sessionOf(page).getByRole('button', { name: 'Switch' }).click()
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Large (medium)')
    await expect(chipOf(bobPage, 'routed')).toHaveText('Mistral Large (medium)')
    await bobPage.context().close()

    await page.keyboard.press('Escape')
    await promptAndWait(page, 'Continue on large', 2)
    await expect(messageItemsOf(page).filter({ hasText: 'Start on the default' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('new session')
  })

  test('As a prompter, I change the effort, set between the main model and the subagents, and the next turn runs on the same model at that effort with the context kept', {
    tag: ['@spec-25', '@stage-h'],
  }, async ({ page, agentScript }) => {
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
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Medium (high)')
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Think harder')
    await expect(messageItemsOf(page).filter({ hasText: 'Effort high with 2 prompts.' })).toHaveCount(1)
  })

  test('As a prompter, I set the subagent policy and it persists', { tag: ['@spec-15'] }, async ({ page }) => {
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

  test('As a member with a decision model, I get routed by it when it is confident', {
    tag: ['@spec-15', '@smoke'],
  }, async ({ page, agentScript }) => {
    await addLlmKey(page, 'Typesafe')
    const chatId = await newRuntimeChat(page, 'Decided')
    await agentScript(chatId, { route: { tier: 'large', confidence: 0.9, effort: 'high' } })
    await promptAndWait(page, 'Decide', 1)
    await expect(chipOf(page, 'routed')).toHaveText('Mistral Large (high)')
  })

  test('As a member whose only key is a decision model, I am told to add an LLM key and cannot pick it', {
    tag: ['@spec-15'],
  }, async ({ browser, workerStack }) => {
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
})
