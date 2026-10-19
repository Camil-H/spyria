import {
  addCredential,
  expect,
  expectLooks,
  type Locator,
  llmSectionOf,
  mainOf,
  openProfile,
  type Page,
  test,
} from './fixtures'

const sectionOf = (page: Page, sectionName: string) => mainOf(page).getByRole('region', { name: sectionName })
const credentialRowOf = (page: Page, provider: string) =>
  llmSectionOf(page).getByRole('listitem').filter({ hasText: provider })

test.describe('Profile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openProfile(page)
  })

  test('As a member, I see my profile’s sections, a display name form, LLM fields aligned on one row above my keys, headings in the app text colour and every field labelled', async ({
    page,
  }) => {
    await expectLooks(page, mainOf(page), 'profile')
    await test.step('shows the heading and two sections, without a name subtitle or a Display name heading', async () => {
      await expect(mainOf(page).getByText('Alice', { exact: true })).toHaveCount(0)
      await expect(mainOf(page).getByRole('heading', { name: 'Display name' })).toHaveCount(0)
      await expect(sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' })).toBeVisible()
      await expect(sectionOf(page, 'Display name').getByText('Display name', { exact: true })).toBeVisible()
      await expect(llmSectionOf(page).getByRole('heading', { level: 2, name: 'LLM access' })).toBeVisible()
      await expect(sectionOf(page, 'Connections').getByRole('heading', { level: 2, name: 'Connections' })).toBeVisible()
    })

    await test.step('is prefilled and Save is disabled while unchanged or blank', async () => {
      const displayNameBox = sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' })
      const saveButton = sectionOf(page, 'Display name').getByRole('button', { name: 'Save' })
      await expect(displayNameBox).toHaveValue('Alice')
      await expect(saveButton).toBeDisabled()
      await displayNameBox.fill('   ')
      await expect(saveButton).toBeDisabled()
      await displayNameBox.fill('Alice D.')
      await expect(saveButton).toBeEnabled()
    })

    await test.step('aligns the fields and the Add button on one grid row', async () => {
      const fieldBoxes = await Promise.all(
        ['Provider', 'Secret'].map((fieldName) => llmSectionOf(page).getByLabel(fieldName).boundingBox()),
      )
      const addBox = (await llmSectionOf(page).getByRole('button', { name: 'Add' }).boundingBox())!
      const tops = fieldBoxes.map((box) => box!.y)
      const heights = fieldBoxes.map((box) => box!.height)
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1.5)
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5)
      expect(Math.abs(addBox.y + addBox.height / 2 - (tops[0]! + heights[0]! / 2))).toBeLessThan(2)
      expect(fieldBoxes[1]!.x - (fieldBoxes[0]!.x + fieldBoxes[0]!.width)).toBeGreaterThan(0)
      expect(addBox.x).toBeGreaterThan(fieldBoxes[1]!.x + fieldBoxes[1]!.width)
    })

    await test.step('puts the add form above the registered credentials', async () => {
      const addButtonBox = (await llmSectionOf(page).getByRole('button', { name: 'Add' }).boundingBox())!
      const firstCredentialBox = (await llmSectionOf(page).getByRole('listitem').first().boundingBox())!
      expect(addButtonBox.y + addButtonBox.height).toBeLessThan(firstCredentialBox.y)
    })

    await test.step('uses the app text color for the section headings in dark mode', async () => {
      await page.emulateMedia({ colorScheme: 'dark' })
      const pageTitleColor = await mainOf(page)
        .getByRole('heading', { level: 1 })
        .evaluate((element) => getComputedStyle(element).color)
      for (const sectionName of ['LLM access', 'Connections']) {
        const headingColor = await sectionOf(page, sectionName)
          .getByRole('heading', { level: 2, name: sectionName })
          .evaluate((element) => getComputedStyle(element).color)
        expect(headingColor).toBe(pageTitleColor)
      }
    })

    await test.step('gives every field an accessible label', async () => {
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
      expect(unlabelledFields).toBe(0)
    })
  })

  test('As a member, I see my keys below the form, their provider, mask and Remove aligned in columns with the form', async ({
    page,
  }) => {
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })
    await expect(credentialRowOf(page, 'OpenAI')).toContainText('••••7890')
    await test.step('keeps a newly added credential below the form', async () => {
      const providerFieldBox = (await llmSectionOf(page).getByLabel('Provider').boundingBox())!
      const newCredentialBox = (await credentialRowOf(page, 'OpenAI').boundingBox())!
      expect(providerFieldBox.y + providerFieldBox.height).toBeLessThan(newCredentialBox.y)
    })

    await test.step('aligns provider, mask and Remove in columns across rows and with the add form', async () => {
      await addCredential(page, { provider: 'Mistral', secret: 'key-mistral-abcdef9999' })
      const leftEdgeOf = async (locator: Locator) => (await locator.boundingBox())!.x
      const rightEdgeOf = async (locator: Locator) => {
        const box = (await locator.boundingBox())!
        return box.x + box.width
      }
      const providerEdges = await Promise.all(
        ['Anthropic', 'OpenAI', 'Mistral'].map((provider) =>
          leftEdgeOf(credentialRowOf(page, provider).getByText(provider, { exact: true })),
        ),
      )
      const maskEdges = await Promise.all([
        leftEdgeOf(credentialRowOf(page, 'Anthropic').getByText('••••a1b2')),
        leftEdgeOf(credentialRowOf(page, 'OpenAI').getByText('••••7890')),
        leftEdgeOf(credentialRowOf(page, 'Mistral').getByText('••••9999')),
      ])
      const removeEdges = await Promise.all(
        ['Anthropic', 'OpenAI', 'Mistral'].map((provider) =>
          rightEdgeOf(credentialRowOf(page, provider).getByRole('button', { name: `Remove ${provider}` })),
        ),
      )
      const spread = (edges: number[]) => Math.max(...edges) - Math.min(...edges)
      expect(spread(providerEdges)).toBeLessThan(1.5)
      expect(spread(maskEdges)).toBeLessThan(1.5)
      expect(spread(removeEdges)).toBeLessThan(1.5)
      expect(Math.abs(providerEdges[0]! - (await leftEdgeOf(llmSectionOf(page).getByLabel('Provider'))))).toBeLessThan(
        1.5,
      )
      expect(Math.abs(maskEdges[0]! - (await leftEdgeOf(llmSectionOf(page).getByLabel('Secret'))))).toBeLessThan(1.5)
      expect(
        Math.abs(removeEdges[0]! - (await rightEdgeOf(llmSectionOf(page).getByRole('button', { name: 'Add' })))),
      ).toBeLessThan(1.5)
    })
    await expectLooks(page, llmSectionOf(page), 'llm-keys')
  })

  test('As a member without keys, I see the empty message below the form', async ({ page }) => {
    await llmSectionOf(page).getByRole('button', { name: 'Remove Anthropic' }).click()
    await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
    await expect(llmSectionOf(page)).toContainText('No LLM keys yet')
    await test.step('shows the empty message below the form', async () => {
      const addButtonBox = (await llmSectionOf(page).getByRole('button', { name: 'Add' }).boundingBox())!
      const emptyMessageBox = (await llmSectionOf(page).getByText('No LLM keys yet').boundingBox())!
      expect(addButtonBox.y + addButtonBox.height).toBeLessThan(emptyMessageBox.y)
    })
  })
})
