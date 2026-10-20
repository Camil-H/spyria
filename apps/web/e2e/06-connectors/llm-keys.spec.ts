import { openPageAs } from '../stack'
import {
  addCredential,
  addLlmKey,
  addParticipant,
  agentReplyText,
  blockedNotice,
  composerOf,
  expect,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openProfile,
  type Page,
  sendButtonOf,
  sendMessage,
  test,
} from './fixtures'

const credentialRowOf = (page: Page, provider: string) =>
  llmSectionOf(page).getByRole('listitem').filter({ hasText: provider })
const removeKey = async (page: Page, provider: string) => {
  await openProfile(page)
  await llmSectionOf(page)
    .getByRole('button', { name: `Remove ${provider}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
  await expect(llmSectionOf(page).getByRole('button', { name: `Remove ${provider}` })).toHaveCount(0)
}
const newSecret = (prefix = 'fake-key') => `${prefix}-${crypto.randomUUID()}`

test.describe('LLM keys', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I add an API key shown only by its last 4 characters, and the form is cleared', async ({
    page,
  }) => {
    await openProfile(page)

    await test.step('adds an API key, shows only its last 4 characters and clears the form', async () => {
      await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })
      await expect(credentialRowOf(page, 'OpenAI')).toContainText('••••7890')
      await expect(llmSectionOf(page).getByLabel('Provider')).toHaveValue('')
      await expect(llmSectionOf(page).getByLabel('Secret')).toHaveValue('')
      expect(await page.content()).not.toContain('sk-test-1234567890')
      const inputValues = await page
        .locator('input, textarea')
        .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value))
      expect(inputValues.join('|')).not.toContain('sk-test-1234567890')
    })
  })

  test('As a member, I see my key masked, and the form takes only a provider and a secret', async ({ page }) => {
    await openProfile(page)

    await test.step('shows the credential masked, without the full secret anywhere', async () => {
      await expect(credentialRowOf(page, 'Anthropic')).toContainText('••••a1b2')
    })

    await test.step('has only the Provider and Secret fields: no Label, Kind or Credential kind switch', async () => {
      for (const removedField of ['Label', 'Kind', 'Credential']) {
        await expect(llmSectionOf(page).getByLabel(removedField)).toHaveCount(0)
      }
      await expect(llmSectionOf(page).getByText(/Plan/)).toHaveCount(0)
    })

    await test.step('disables Add while the provider or the secret is blank', async () => {
      const addButton = llmSectionOf(page).getByRole('button', { name: 'Add' })
      await expect(addButton).toBeDisabled()
      await llmSectionOf(page).getByLabel('Provider').fill('OpenAI')
      await expect(addButton).toBeDisabled()
      await llmSectionOf(page).getByLabel('Secret').fill('sk-test-1234567890')
      await expect(addButton).toBeEnabled()
      await llmSectionOf(page).getByLabel('Provider').fill('   ')
      await expect(addButton).toBeDisabled()
    })

    await test.step('keeps the secret field a password input', async () => {
      await expect(llmSectionOf(page).getByLabel('Secret')).toHaveAttribute('type', 'password')
    })

    await test.step('keeps the credential when the removal is cancelled', async () => {
      await llmSectionOf(page).getByRole('button', { name: 'Remove Anthropic' }).click()
      await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog', { name: 'Remove LLM key' })).toHaveCount(0)
      await expect(credentialRowOf(page, 'Anthropic')).toBeVisible()
    })

    await test.step('does not block when a credential exists', async () => {
      await openChat(page, 'Research')
      await expect(mainOf(page)).not.toContainText(blockedNotice)
      await composerOf(page).fill('Allowed')
      await expect(sendButtonOf(page)).toBeEnabled()
    })
  })

  test('As a member, I remove my only key and cannot prompt in runtime chats until I add one, while channels still work', async ({
    page,
  }) => {
    await openProfile(page)

    await test.step('removes the credential after confirmation and shows the empty state', async () => {
      await llmSectionOf(page).getByRole('button', { name: 'Remove Anthropic' }).click()
      await expect(page.getByRole('dialog', { name: 'Remove LLM key' })).toContainText('Anthropic')
      await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
      await expect(credentialRowOf(page, 'Anthropic')).toHaveCount(0)
      await expect(llmSectionOf(page)).toContainText('No LLM keys yet')
    })

    await test.step('blocks Send in a runtime chat without any credential but keeps drafting possible', async () => {
      await openChat(page, 'Research')
      await expect(mainOf(page)).toContainText(blockedNotice)
      await expect(mainOf(page).getByRole('link', { name: 'Open profile' })).toBeVisible()
      await composerOf(page).fill('Draft that cannot be sent')
      await expect(composerOf(page)).toHaveValue('Draft that cannot be sent')
      await expect(sendButtonOf(page)).toBeDisabled()
      await composerOf(page).press('ControlOrMeta+Enter')
      await expect(messageItemsOf(page)).toHaveCount(0)
    })

    await test.step('does not block channels', async () => {
      await openChat(page, 'Welcome')
      await expect(mainOf(page)).not.toContainText(blockedNotice)
      await composerOf(page).fill('Still works in a channel')
      await expect(sendButtonOf(page)).toBeEnabled()
      await composerOf(page).press('ControlOrMeta+Enter')
      await expect(messageItemsOf(page).last()).toContainText('Still works in a channel')
    })

    await test.step('follows the credentials without a reload and links to the profile', async () => {
      await openChat(page, 'Research')
      await composerOf(page).fill('Waiting for a key')
      await expect(sendButtonOf(page)).toBeDisabled()
      await mainOf(page).getByRole('link', { name: 'Open profile' }).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
      await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })
      await openChat(page, 'Research')
      await expect(mainOf(page)).not.toContainText(blockedNotice)
      await expect(composerOf(page)).toHaveValue('Waiting for a key')
      await expect(sendButtonOf(page)).toBeEnabled()
    })
  })

  test('As a member without a key, I cannot prompt; after removing my key I can no longer prompt, while another member still can', {
    tag: ['@spec-12'],
  }, async ({ page, browser, workerStack }) => {
    await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await test.step('a member without a key cannot prompt', async () => {
      await openChat(bobPage, 'Research')
      await expect(mainOf(bobPage)).toContainText(blockedNotice)
      await expect(sendButtonOf(bobPage)).toBeDisabled()
    })
    await addLlmKey(bobPage, 'Mistral', newSecret())
    await openChat(page, 'Research')
    await sendMessage(page, 'Before removing my key')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)

    await removeKey(page, 'Anthropic')
    await openChat(page, 'Research')
    await expect(mainOf(page)).toContainText(blockedNotice)
    await expect(sendButtonOf(page)).toBeDisabled()

    await openChat(bobPage, 'Research')
    await sendMessage(bobPage, 'Bob still prompts')
    await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(2)
    await bobPage.context().close()
  })
})
