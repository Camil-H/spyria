import { addCredential, addKeyDialogOf, expect, mainOf, openProfile, openSettings, type Page, test } from '../fixtures'

const providersOf = (page: Page) => mainOf(page).getByRole('region', { name: 'AI providers' })
const providerSwitchOf = (page: Page, name: string) => providersOf(page).getByRole('switch', { name, exact: true })

test.describe('AI providers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member who can manage AI providers, I turn a provider off, a key for it is refused, and allowing every provider turns it back on, while choosing only the ones turned on keeps every provider on as an allow-list', {
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

    await openProfile(page, 'LLM keys')
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-refused-1234' })
    await expect(addKeyDialogOf(page)).toContainText('OpenAI is not allowed in this workspace')
    await addKeyDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(addKeyDialogOf(page)).toHaveCount(0)

    await openSettings(page, 'AI providers')
    const everyProvider = providersOf(page).getByRole('radio', { name: 'Every provider' })
    await everyProvider.click()
    await expect(everyProvider).toBeChecked()
    await expect(providerSwitchOf(page, 'OpenAI')).toHaveAttribute('aria-checked', 'true')

    const onlyTurnedOn = providersOf(page).getByRole('radio', { name: 'Only the ones turned on' })
    await onlyTurnedOn.click()
    await expect(onlyTurnedOn).toBeChecked()
    await expect(providerSwitchOf(page, 'OpenAI')).toHaveAttribute('aria-checked', 'true')
    await expect(providerSwitchOf(page, 'Mistral')).toHaveAttribute('aria-checked', 'true')
    await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(mainOf(page).getByRole('link', { name: 'AI providers', exact: true })).toContainText(
      '10 allowed providers',
    )
  })
})
