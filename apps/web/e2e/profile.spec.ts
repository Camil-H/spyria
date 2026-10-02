import { expect, type Page, test } from '@playwright/test'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const mainOf = (page: Page) => page.getByRole('main')
const sectionOf = (page: Page, sectionName: string) => mainOf(page).getByRole('region', { name: sectionName })
const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const sendButtonOf = (page: Page) => page.getByRole('button', { name: 'Send' })
const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')

const openProfile = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
}

const openChat = async (page: Page, chatName: string) => {
  await sidebarOf(page).getByRole('link', { name: chatName }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

const addCredential = async (
  page: Page,
  credential: { provider: string; kind: 'API key' | 'Plan login'; secret: string; label?: string },
) => {
  const llmSection = sectionOf(page, 'LLM access')
  await llmSection.getByLabel('Provider').fill(credential.provider)
  await llmSection.getByLabel('Kind').selectOption(credential.kind)
  if (credential.label) await llmSection.getByLabel('Label').fill(credential.label)
  await llmSection.getByLabel(credential.kind === 'Plan login' ? 'Credential' : 'Secret').fill(credential.secret)
  await llmSection.getByRole('button', { name: 'Add' }).click()
}

const removeCredential = async (page: Page, provider: string) => {
  await sectionOf(page, 'LLM access')
    .getByRole('button', { name: `Remove ${provider}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. layout', () => {
  test('shows the heading and the three sections', async ({ page }) => {
    await openProfile(page)
    await expect(sectionOf(page, 'Display name').getByRole('heading', { level: 2, name: 'Display name' })).toBeVisible()
    await expect(sectionOf(page, 'LLM access').getByRole('heading', { level: 2, name: 'LLM access' })).toBeVisible()
    await expect(sectionOf(page, 'Connections').getByRole('heading', { level: 2, name: 'Connections' })).toBeVisible()
    await expect(sectionOf(page, 'Shared with me').getByRole('heading', { level: 3 })).toBeVisible()
    await expect(sectionOf(page, 'My personal connections').getByRole('heading', { level: 3 })).toBeVisible()
  })
})

test.describe('2. display name', () => {
  test('is prefilled and Save is disabled while unchanged or blank', async ({ page }) => {
    await openProfile(page)
    const displayNameBox = sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' })
    const saveButton = sectionOf(page, 'Display name').getByRole('button', { name: 'Save' })
    await expect(displayNameBox).toHaveValue('Alice')
    await expect(saveButton).toBeDisabled()

    await displayNameBox.fill('   ')
    await expect(saveButton).toBeDisabled()
    await displayNameBox.fill('Alice D.')
    await expect(saveButton).toBeEnabled()
  })

  test('saves the new name and shows it everywhere', async ({ page }) => {
    await openProfile(page)
    await sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' }).fill('Alice D.')
    await sectionOf(page, 'Display name').getByRole('button', { name: 'Save' }).click()
    await expect(sectionOf(page, 'Display name').getByText('Saved')).toBeVisible()

    await openChat(page, 'Welcome')
    await expect(messageItemsOf(page).nth(1)).toContainText('Alice D.')

    await openChat(page, 'Invoice bug')
    await expect(mainOf(page).getByText('Agent acts as')).toContainText('Alice D.')
    await page.getByRole('tab', { name: 'Usage' }).click()
    await expect(page.getByRole('tabpanel').getByRole('row', { name: /Alice D\./ })).toBeVisible()
    await page.getByRole('tab', { name: 'Members' }).click()
    await expect(page.getByRole('tabpanel').getByRole('listitem').filter({ hasText: 'Alice D.' })).toContainText(
      'Owner',
    )
  })
})

test.describe('3. LLM credentials list', () => {
  test('shows the credential masked, without the full secret anywhere', async ({ page }) => {
    await openProfile(page)
    const credential = sectionOf(page, 'LLM access').getByRole('listitem').filter({ hasText: 'Anthropic' })
    await expect(credential).toContainText('API key')
    await expect(credential).toContainText('Work key')
    await expect(credential).toContainText('••••a1b2')
  })
})

test.describe('4. add a credential', () => {
  test('disables Add while the provider or the secret is blank', async ({ page }) => {
    await openProfile(page)
    const llmSection = sectionOf(page, 'LLM access')
    const addButton = llmSection.getByRole('button', { name: 'Add' })
    await expect(addButton).toBeDisabled()
    await llmSection.getByLabel('Provider').fill('OpenAI')
    await expect(addButton).toBeDisabled()
    await llmSection.getByLabel('Secret').fill('sk-test-1234567890')
    await expect(addButton).toBeEnabled()
    await llmSection.getByLabel('Provider').fill('   ')
    await expect(addButton).toBeDisabled()
  })

  test('adds an API key, shows only its last 4 characters and clears the form', async ({ page }) => {
    await openProfile(page)
    await addCredential(page, { provider: 'OpenAI', kind: 'API key', secret: 'sk-test-1234567890' })

    const credential = sectionOf(page, 'LLM access').getByRole('listitem').filter({ hasText: 'OpenAI' })
    await expect(credential).toContainText('API key')
    await expect(credential).toContainText('••••7890')
    await expect(sectionOf(page, 'LLM access').getByLabel('Provider')).toHaveValue('')
    await expect(sectionOf(page, 'LLM access').getByLabel('Secret')).toHaveValue('')

    expect(await page.content()).not.toContain('sk-test-1234567890')
    const inputValues = await page
      .locator('input, textarea')
      .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value))
    expect(inputValues.join('|')).not.toContain('sk-test-1234567890')
  })

  test('keeps the secret field a password input', async ({ page }) => {
    await openProfile(page)
    await expect(sectionOf(page, 'LLM access').getByLabel('Secret')).toHaveAttribute('type', 'password')
  })

  test('adds a plan login with a Credential field, a Plan badge and a Verified status', async ({ page }) => {
    await openProfile(page)
    const llmSection = sectionOf(page, 'LLM access')
    await llmSection.getByLabel('Kind').selectOption('Plan login')
    await expect(llmSection.getByLabel('Credential')).toHaveAttribute('type', 'password')

    await addCredential(page, { provider: 'Claude Code', kind: 'Plan login', secret: 'oauth-token-abcdef9999' })

    const credential = llmSection.getByRole('listitem').filter({ hasText: 'Claude Code' })
    await expect(credential).toContainText('Plan login')
    await expect(credential).toContainText('Plan')
    await expect(credential).toContainText('••••9999')
    await expect(credential).toContainText('Verified')
    expect(await page.content()).not.toContain('oauth-token-abcdef9999')
  })
})

test.describe('5. remove a credential', () => {
  test('removes the credential after confirmation and shows the empty state', async ({ page }) => {
    await openProfile(page)
    await sectionOf(page, 'LLM access').getByRole('button', { name: 'Remove Anthropic' }).click()
    await expect(page.getByRole('dialog', { name: 'Remove LLM key' })).toContainText('Anthropic')
    await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()

    await expect(sectionOf(page, 'LLM access').getByRole('listitem').filter({ hasText: 'Anthropic' })).toHaveCount(0)
    await expect(sectionOf(page, 'LLM access')).toContainText('No LLM keys yet')
  })

  test('keeps the credential when the removal is cancelled', async ({ page }) => {
    await openProfile(page)
    await sectionOf(page, 'LLM access').getByRole('button', { name: 'Remove Anthropic' }).click()
    await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog', { name: 'Remove LLM key' })).toHaveCount(0)
    await expect(sectionOf(page, 'LLM access').getByRole('listitem').filter({ hasText: 'Anthropic' })).toBeVisible()
  })
})

test.describe('6. prompting needs a key', () => {
  const blockedNotice = 'Connect an LLM key in your profile to prompt'

  test('blocks Send in a runtime chat without any credential but keeps drafting possible', async ({ page }) => {
    await openProfile(page)
    await removeCredential(page, 'Anthropic')

    await openChat(page, 'Research')
    await expect(mainOf(page)).toContainText(blockedNotice)
    await expect(mainOf(page).getByRole('link', { name: 'Open profile' })).toBeVisible()

    await composerOf(page).fill('Draft that cannot be sent')
    await expect(composerOf(page)).toHaveValue('Draft that cannot be sent')
    await expect(sendButtonOf(page)).toBeDisabled()
    await composerOf(page).press('ControlOrMeta+Enter')
    await expect(messageItemsOf(page)).toHaveCount(0)
  })

  test('does not block channels', async ({ page }) => {
    await openProfile(page)
    await removeCredential(page, 'Anthropic')

    await openChat(page, 'Welcome')
    await expect(mainOf(page)).not.toContainText(blockedNotice)
    await composerOf(page).fill('Still works in a channel')
    await expect(sendButtonOf(page)).toBeEnabled()
    await composerOf(page).press('ControlOrMeta+Enter')
    await expect(messageItemsOf(page).last()).toContainText('Still works in a channel')
  })

  test('does not block when a credential exists', async ({ page }) => {
    await openChat(page, 'Research')
    await expect(mainOf(page)).not.toContainText(blockedNotice)
    await composerOf(page).fill('Allowed')
    await expect(sendButtonOf(page)).toBeEnabled()
  })

  test('follows the credentials without a reload and links to the profile', async ({ page }) => {
    await openProfile(page)
    await removeCredential(page, 'Anthropic')
    await openChat(page, 'Research')
    await composerOf(page).fill('Waiting for a key')
    await expect(sendButtonOf(page)).toBeDisabled()

    await mainOf(page).getByRole('link', { name: 'Open profile' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    await addCredential(page, { provider: 'OpenAI', kind: 'API key', secret: 'sk-test-1234567890' })

    await openChat(page, 'Research')
    await expect(mainOf(page)).not.toContainText(blockedNotice)
    await expect(composerOf(page)).toHaveValue('Waiting for a key')
    await expect(sendButtonOf(page)).toBeEnabled()
  })
})

test.describe('7. workspace connections shared with me', () => {
  test('lists the shared connections with the access of the member, read-only', async ({ page }) => {
    await openProfile(page)
    const sharedSection = sectionOf(page, 'Shared with me')
    await expect(sharedSection.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('2 of 5 tables')
    await expect(sharedSection.getByRole('listitem').filter({ hasText: 'Onyx' })).toContainText('All sources')
    await expect(sharedSection.getByRole('button')).toHaveCount(0)
  })
})

test.describe('8. personal connections', () => {
  const personalSectionOf = (page: Page) => sectionOf(page, 'My personal connections')

  test('lists the connections with their status and the matching actions', async ({ page }) => {
    await openProfile(page)
    const personalSection = personalSectionOf(page)
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'GitHub' })).toContainText('Connected')
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected')
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'Notion' })).toContainText(
      'Needs reconnection',
    )
    await expect(personalSection.getByRole('button', { name: 'Disconnect GitHub' })).toBeVisible()
    await expect(personalSection.getByRole('button', { name: 'Reconnect Notion' })).toBeVisible()
    await expect(personalSection.getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible()
  })

  test('reconnects a tool that needs reconnection', async ({ page }) => {
    await openProfile(page)
    await personalSectionOf(page).getByRole('button', { name: 'Reconnect Notion' }).click()
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).toContainText('Connected')
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).not.toContainText(
      'Needs reconnection',
    )
    await expect(personalSectionOf(page).getByRole('button', { name: 'Reconnect Notion' })).toHaveCount(0)
  })

  test('connects a tool of the catalog', async ({ page }) => {
    await openProfile(page)
    await personalSectionOf(page).getByRole('button', { name: 'Connect Linear', exact: true }).click()
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Linear' })).toContainText('Connected')
    await expect(personalSectionOf(page).getByRole('button', { name: 'Connect Linear', exact: true })).toHaveCount(0)
  })

  test('disconnects a tool and offers to connect it again', async ({ page }) => {
    await openProfile(page)
    await personalSectionOf(page).getByRole('button', { name: 'Disconnect GitHub' }).click()
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(personalSectionOf(page).getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
  })
})

test.describe('9. panel follows', () => {
  test('shows the workspace and personal groups for the owner of the chat', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await page.getByRole('tab', { name: 'Connected tools' }).click()
    const workspaceGroup = page.getByRole('tabpanel').getByRole('region', { name: 'Workspace' })
    const personalGroup = page.getByRole('tabpanel').getByRole('region', { name: 'Personal' })
    await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('2 of 5 tables')
    await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Onyx' })).toContainText('All sources')
    await expect(personalGroup.getByRole('listitem').filter({ hasText: 'GitHub' })).toContainText('Connected')
  })

  test('reflects a disconnection made in the profile', async ({ page }) => {
    await openProfile(page)
    await sectionOf(page, 'My personal connections').getByRole('button', { name: 'Disconnect GitHub' }).click()

    await openChat(page, 'Invoice bug')
    await page.getByRole('tab', { name: 'Connected tools' }).click()
    const personalGroup = page.getByRole('tabpanel').getByRole('region', { name: 'Personal' })
    await expect(personalGroup.getByRole('listitem').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Slack' })).toBeVisible()
  })

  test('shows the empty message of a group when the owner has no personal connection', async ({ page }) => {
    await openChat(page, 'Setup helper')
    await page.getByRole('tab', { name: 'Connected tools' }).click()
    const workspaceGroup = page.getByRole('tabpanel').getByRole('region', { name: 'Workspace' })
    const personalGroup = page.getByRole('tabpanel').getByRole('region', { name: 'Personal' })
    await expect(workspaceGroup.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('1 of 5 tables')
    await expect(personalGroup).toContainText('No personal connections')
  })
})

test.describe('10. theming and access', () => {
  test('uses the app text color for the section headings in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openProfile(page)
    const pageTitleColor = await mainOf(page)
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).color)
    for (const sectionName of ['Display name', 'LLM access', 'Connections']) {
      const headingColor = await sectionOf(page, sectionName)
        .getByRole('heading', { level: 2, name: sectionName })
        .evaluate((element) => getComputedStyle(element).color)
      expect(headingColor).toBe(pageTitleColor)
    }
  })

  test('gives every field an accessible label', async ({ page }) => {
    await openProfile(page)
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
