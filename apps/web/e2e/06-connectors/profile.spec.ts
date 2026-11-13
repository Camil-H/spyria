import { addCredential, expect, llmSectionOf, mainOf, openProfile, type Page, sidebarOf, test } from '../fixtures'

const cardOf = (page: Page, title: string) => mainOf(page).getByRole('link', { name: title, exact: true })
const credentialRowOf = (page: Page, provider: string) =>
  llmSectionOf(page).getByRole('listitem').filter({ hasText: provider })

test.describe('Profile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see my name and email above one card per part of my profile, each saying what it is for and where it stands, and I open one and come back', async ({
    page,
  }) => {
    await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()

    await test.step('shows my name and email under the heading', async () => {
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
      await expect(mainOf(page).getByText('alice@example.com', { exact: true })).toBeVisible()
      await expect(mainOf(page).getByText('Alice', { exact: true })).toBeVisible()
    })

    await test.step('lists the cards with what each is for and its status', async () => {
      for (const title of ['Account', 'LLM keys', 'My machine', 'Connections', 'Usage'])
        await expect(cardOf(page, title)).toBeVisible()
      await expect(cardOf(page, 'LLM keys')).toHaveAccessibleDescription('Your own keys, used when you prompt 1 key')
      await expect(cardOf(page, 'My machine')).toHaveAccessibleDescription(
        'Claude Code and Codex on your computer Not added',
      )
    })

    await test.step('opens a card, and Escape brings me back to the cards', async () => {
      await cardOf(page, 'LLM keys').click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'LLM keys' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    })
  })

  test('As a member, I add a key from its dialog, see each key as a row with its mask and Remove, and the card counts them', async ({
    page,
  }) => {
    await openProfile(page, 'LLM keys')
    await expect(credentialRowOf(page, 'Anthropic')).toHaveText('Anthropic••••a1b2Remove')

    await addCredential(page, { provider: 'OpenAI', secret: 'fake-key-7890' })
    await expect(credentialRowOf(page, 'OpenAI')).toHaveText('OpenAI••••7890Remove')
    await expect(page.getByRole('dialog', { name: 'Add LLM key' })).toHaveCount(0)

    await mainOf(page).getByRole('link', { name: 'Back to Profile' }).click()
    await expect(cardOf(page, 'LLM keys')).toHaveAccessibleDescription('Your own keys, used when you prompt 2 keys')
  })

  test('As a member, I find my display name prefilled on my Account page, and Save stays disabled while it is unchanged or blank', async ({
    page,
  }) => {
    await openProfile(page, 'Account')
    const displayName = mainOf(page).getByRole('region', { name: 'Display name' })
    const displayNameBox = displayName.getByRole('textbox', { name: 'Display name' })
    const saveButton = displayName.getByRole('button', { name: 'Save' })
    await expect(displayNameBox).toHaveValue('Alice')
    await expect(saveButton).toBeDisabled()
    await displayNameBox.fill('   ')
    await expect(saveButton).toBeDisabled()
    await displayNameBox.fill('Alice D.')
    await expect(saveButton).toBeEnabled()
  })

  test('As a member, every field of my profile’s pages has an accessible label', async ({ page }) => {
    for (const card of ['Account', 'LLM keys', 'My machine', 'Connections', 'Usage'] as const) {
      await openProfile(page, card)
      const unlabelledFields = await mainOf(page)
        .locator('input, select, textarea')
        .evaluateAll(
          (fields) =>
            fields.filter(
              (field) =>
                !(field as HTMLInputElement).labels?.length &&
                !field.getAttribute('aria-label') &&
                !field.getAttribute('aria-labelledby'),
            ).length,
        )
      expect(unlabelledFields, card).toBe(0)
    }
  })
})
