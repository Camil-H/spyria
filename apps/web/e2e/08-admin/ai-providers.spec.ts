import { addCredential, expect, llmSectionOf, mainOf, openProfile, openSettings, type Page, test } from '../fixtures'

const providersOf = (page: Page) => mainOf(page).getByRole('region', { name: 'AI providers' })
const providerSwitchOf = (page: Page, name: string) => providersOf(page).getByRole('switch', { name, exact: true })

test.describe('AI providers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member who can manage AI providers, I turn a provider off, a key for it is refused, and allowing every provider turns it back on', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    await openSettings(page, 'AI providers')
    await expect(providersOf(page).getByRole('checkbox')).toHaveCount(0)
    await expect(providerSwitchOf(page, 'OpenAI')).toHaveAttribute('aria-checked', 'true')
    await providerSwitchOf(page, 'OpenAI').click()
    await expect(providerSwitchOf(page, 'OpenAI')).toHaveAttribute('aria-checked', 'false')
    await expect(providerSwitchOf(page, 'Mistral')).toHaveAttribute('aria-checked', 'true')
    await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(mainOf(page).getByRole('link', { name: 'AI providers', exact: true })).toContainText(
      '9 allowed providers',
    )

    await openProfile(page)
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-refused-1234' })
    await expect(llmSectionOf(page)).toContainText('OpenAI is not allowed in this workspace')

    await openSettings(page, 'AI providers')
    await providersOf(page).getByRole('button', { name: 'Allow every provider' }).click()
    await expect(providerSwitchOf(page, 'OpenAI')).toHaveAttribute('aria-checked', 'true')
  })
})
