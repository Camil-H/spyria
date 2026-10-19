import {
  addLlmKey,
  agentReplyText,
  expect,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'

const removeKey = async (page: Page, provider: string) => {
  await openProfile(page)
  await llmSectionOf(page)
    .getByRole('button', { name: `Remove ${provider}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
  await expect(llmSectionOf(page).getByRole('button', { name: `Remove ${provider}` })).toHaveCount(0)
}
const newSecret = (prefix = 'fake-key') => `${prefix}-${crypto.randomUUID()}`
test.describe('Errors', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a prompter whose key the provider refuses, I see the turn end with Spyria’s notice and no provider text', {
    tag: ['@spec-12'],
  }, async ({ page }) => {
    await removeKey(page, 'Anthropic')
    await addLlmKey(page, 'Fake', newSecret('fake-refused'))
    await openChat(page, 'Research')
    await sendMessage(page, 'Use my refused key')

    const error = messageItemsOf(page).getByRole('alert')
    await expect(error).toContainText('The LLM key of Alice was refused')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('Incorrect API key')
    await expect(mainOf(page)).not.toContainText('fake-refused')
  })

  test('As a prompter, I get Spyria’s notice while the gateway is down, and my next prompt is answered once it is back', {
    tag: ['@spec-12'],
  }, async ({ page, workerStack }) => {
    await openChat(page, 'Research')
    await workerStack.setGatewayReachable(false)
    await sendMessage(page, 'While the gateway is down')
    await expect(messageItemsOf(page).getByRole('alert')).toContainText('The model gateway is unreachable')
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    await workerStack.setGatewayReachable(true)
    await sendMessage(page, 'Now that it is back')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  })

  test('As a prompter, I see a provider error once with the relay’s notice, and an error the relay did not see with the agent’s own message', {
    tag: ['@spec-25', '@stage-e'],
  }, async ({ page, agentScript }) => {
    const chatId = await newRuntimeChat(page, 'Pi errors')
    await agentScript(chatId, { steps: [{ fail: 'The model is overloaded' }] })
    await sendMessage(page, 'Try anyway')
    const errors = messageItemsOf(page).getByRole('alert')
    await expect(errors).toHaveCount(1)
    await expect(errors).toContainText('The provider is unavailable, try again shortly')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('The agent stopped with an error')

    await sendMessage(page, 'stub:provider-error')
    await expect(errors).toHaveCount(2)
    await expect(errors.nth(1)).toContainText('529 overloaded')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
  })
})
