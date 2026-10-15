import {
  agentReplyText,
  expect,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  openChat,
  openProfile,
  type Page,
  sendButtonOf,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs } from './stack'

const blockedNotice = 'Connect an LLM key in your profile to prompt'

const addKey = async (page: Page, provider: string, secret: string) => {
  await openProfile(page)
  await llmSectionOf(page).getByLabel('Provider').fill(provider)
  await llmSectionOf(page).getByLabel('Secret').fill(secret)
  await llmSectionOf(page).getByRole('button', { name: 'Add' }).click()
  await expect(
    llmSectionOf(page)
      .getByRole('listitem')
      .filter({ hasText: `••••${secret.slice(-4)}` }),
  ).toBeVisible()
}
const removeKey = async (page: Page, provider: string) => {
  await openProfile(page)
  await llmSectionOf(page)
    .getByRole('button', { name: `Remove ${provider}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
  await expect(llmSectionOf(page).getByRole('button', { name: `Remove ${provider}` })).toHaveCount(0)
}
const newSecret = (prefix = 'fake-key') => `${prefix}-${crypto.randomUUID()}`
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('3 and 4. a member without a key cannot prompt; a member who removes their key can no longer prompt, while another member still can', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await test.step('a member without a key cannot prompt', async () => {
    await openChat(bobPage, 'Research')
    await expect(mainOf(bobPage)).toContainText(blockedNotice)
    await expect(sendButtonOf(bobPage)).toBeDisabled()
  })
  await addKey(bobPage, 'Fake', newSecret())
  await openChat(page, 'Research')
  await sendMessage(page, 'Before removing my key')
  await expect(repliesWith(page, agentReplyText)).toHaveCount(1)

  await removeKey(page, 'Anthropic')
  await openChat(page, 'Research')
  await expect(mainOf(page)).toContainText(blockedNotice)
  await expect(sendButtonOf(page)).toBeDisabled()

  await openChat(bobPage, 'Research')
  await sendMessage(bobPage, 'Bob still prompts')
  await expect(repliesWith(bobPage, agentReplyText)).toHaveCount(2)
  await bobPage.context().close()
})

test('5. a key the provider refuses ends the turn with HQ’s notice and no provider text', async ({ page }) => {
  await removeKey(page, 'Anthropic')
  await addKey(page, 'Fake', newSecret('fake-refused'))
  await openChat(page, 'Research')
  await sendMessage(page, 'Use my refused key')

  const error = messageItemsOf(page).getByRole('alert')
  await expect(error).toContainText('The LLM key of Alice was refused')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(mainOf(page)).not.toContainText('Incorrect API key')
  await expect(mainOf(page)).not.toContainText('fake-refused')
})

test('6. with the gateway down a prompt gets HQ’s notice; once it is back the next prompt is answered', async ({
  page,
  workerStack,
}) => {
  await openChat(page, 'Research')
  await workerStack.setGatewayReachable(false)
  await sendMessage(page, 'While the gateway is down')
  await expect(messageItemsOf(page).getByRole('alert')).toContainText('The model gateway is unreachable')
  await expect(workingIndicatorOf(page)).toHaveCount(0)

  await workerStack.setGatewayReachable(true)
  await sendMessage(page, 'Now that it is back')
  await expect(repliesWith(page, agentReplyText)).toHaveCount(1)
})
