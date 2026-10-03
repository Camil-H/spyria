import { expect, type Locator, type Page, test } from '@playwright/test'

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

const addCredential = async (page: Page, credential: { provider: string; secret: string }) => {
  const llmSection = sectionOf(page, 'LLM access')
  await llmSection.getByLabel('Provider').fill(credential.provider)
  await llmSection.getByLabel('Secret').fill(credential.secret)
  await llmSection.getByRole('button', { name: 'Add' }).click()
}

const connectionsTabOf = (page: Page, tabName: 'Shared with me' | 'My connections') =>
  sectionOf(page, 'Connections').getByRole('tab', { name: tabName })
const connectionsPanelOf = (page: Page) => sectionOf(page, 'Connections').getByRole('tabpanel')
const openMyConnections = async (page: Page) => {
  await connectionsTabOf(page, 'My connections').click()
  await expect(connectionsTabOf(page, 'My connections')).toHaveAttribute('aria-selected', 'true')
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
  test('shows the heading and two sections, without a name subtitle or a Display name heading', async ({ page }) => {
    await openProfile(page)
    await expect(mainOf(page).getByText('Alice', { exact: true })).toHaveCount(0)
    await expect(mainOf(page).getByRole('heading', { name: 'Display name' })).toHaveCount(0)
    await expect(sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' })).toBeVisible()
    await expect(sectionOf(page, 'Display name').getByText('Display name', { exact: true })).toBeVisible()
    await expect(sectionOf(page, 'LLM access').getByRole('heading', { level: 2, name: 'LLM access' })).toBeVisible()
    await expect(sectionOf(page, 'Connections').getByRole('heading', { level: 2, name: 'Connections' })).toBeVisible()
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
    await expect(credential).toContainText('••••a1b2')
  })
})

test.describe('3b. add form layout', () => {
  test('has only the Provider and Secret fields: no Label, Kind or Credential kind switch', async ({ page }) => {
    await openProfile(page)
    for (const removedField of ['Label', 'Kind', 'Credential']) {
      await expect(sectionOf(page, 'LLM access').getByLabel(removedField)).toHaveCount(0)
    }
    await expect(sectionOf(page, 'LLM access').getByText(/Plan/)).toHaveCount(0)
  })

  test('aligns the fields and the Add button on one grid row', async ({ page }) => {
    await openProfile(page)
    const llmSection = sectionOf(page, 'LLM access')
    const fieldBoxes = await Promise.all(
      ['Provider', 'Secret'].map((fieldName) => llmSection.getByLabel(fieldName).boundingBox()),
    )
    const addBox = (await llmSection.getByRole('button', { name: 'Add' }).boundingBox())!
    const tops = fieldBoxes.map((box) => box!.y)
    const heights = fieldBoxes.map((box) => box!.height)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1.5)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5)
    expect(Math.abs(addBox.y + addBox.height / 2 - (tops[0]! + heights[0]! / 2))).toBeLessThan(2)

    expect(fieldBoxes[1]!.x - (fieldBoxes[0]!.x + fieldBoxes[0]!.width)).toBeGreaterThan(0)
    expect(addBox.x).toBeGreaterThan(fieldBoxes[1]!.x + fieldBoxes[1]!.width)
  })
})

test.describe('3d. add form above the list', () => {
  test('puts the add form above the registered credentials', async ({ page }) => {
    await openProfile(page)
    const llmSection = sectionOf(page, 'LLM access')
    const addButtonBox = (await llmSection.getByRole('button', { name: 'Add' }).boundingBox())!
    const firstCredentialBox = (await llmSection.getByRole('listitem').first().boundingBox())!
    expect(addButtonBox.y + addButtonBox.height).toBeLessThan(firstCredentialBox.y)
  })

  test('keeps a newly added credential below the form', async ({ page }) => {
    await openProfile(page)
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })
    const llmSection = sectionOf(page, 'LLM access')
    const providerFieldBox = (await llmSection.getByLabel('Provider').boundingBox())!
    const newCredentialBox = (await llmSection.getByRole('listitem').filter({ hasText: 'OpenAI' }).boundingBox())!
    expect(providerFieldBox.y + providerFieldBox.height).toBeLessThan(newCredentialBox.y)
  })

  test('shows the empty message below the form', async ({ page }) => {
    await openProfile(page)
    await removeCredential(page, 'Anthropic')
    const llmSection = sectionOf(page, 'LLM access')
    const addButtonBox = (await llmSection.getByRole('button', { name: 'Add' }).boundingBox())!
    const emptyMessageBox = (await llmSection.getByText('No LLM keys yet').boundingBox())!
    expect(addButtonBox.y + addButtonBox.height).toBeLessThan(emptyMessageBox.y)
  })
})

test.describe('3c. credential list grid', () => {
  test('aligns provider, mask and Remove in columns across rows and with the add form', async ({ page }) => {
    await openProfile(page)
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })
    await addCredential(page, { provider: 'Mistral', secret: 'key-mistral-abcdef9999' })

    const llmSection = sectionOf(page, 'LLM access')
    const rowOf = (provider: string) => llmSection.getByRole('listitem').filter({ hasText: provider })
    const leftEdgeOf = async (locator: Locator) => (await locator.boundingBox())!.x
    const rightEdgeOf = async (locator: Locator) => {
      const box = (await locator.boundingBox())!
      return box.x + box.width
    }

    const providerEdges = await Promise.all(
      ['Anthropic', 'OpenAI', 'Mistral'].map((provider) =>
        leftEdgeOf(rowOf(provider).getByText(provider, { exact: true })),
      ),
    )
    const maskEdges = await Promise.all([
      leftEdgeOf(rowOf('Anthropic').getByText('••••a1b2')),
      leftEdgeOf(rowOf('OpenAI').getByText('••••7890')),
      leftEdgeOf(rowOf('Mistral').getByText('••••9999')),
    ])
    const removeEdges = await Promise.all(
      ['Anthropic', 'OpenAI', 'Mistral'].map((provider) =>
        rightEdgeOf(rowOf(provider).getByRole('button', { name: `Remove ${provider}` })),
      ),
    )
    const spread = (edges: number[]) => Math.max(...edges) - Math.min(...edges)
    expect(spread(providerEdges)).toBeLessThan(1.5)
    expect(spread(maskEdges)).toBeLessThan(1.5)
    expect(spread(removeEdges)).toBeLessThan(1.5)

    expect(Math.abs(providerEdges[0]! - (await leftEdgeOf(llmSection.getByLabel('Provider'))))).toBeLessThan(1.5)
    expect(Math.abs(maskEdges[0]! - (await leftEdgeOf(llmSection.getByLabel('Secret'))))).toBeLessThan(1.5)
    expect(
      Math.abs(removeEdges[0]! - (await rightEdgeOf(llmSection.getByRole('button', { name: 'Add' })))),
    ).toBeLessThan(1.5)
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
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })

    const credential = sectionOf(page, 'LLM access').getByRole('listitem').filter({ hasText: 'OpenAI' })
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
    await addCredential(page, { provider: 'OpenAI', secret: 'sk-test-1234567890' })

    await openChat(page, 'Research')
    await expect(mainOf(page)).not.toContainText(blockedNotice)
    await expect(composerOf(page)).toHaveValue('Waiting for a key')
    await expect(sendButtonOf(page)).toBeEnabled()
  })
})

test.describe('7. connections tabs and shared connections', () => {
  test('shows the two tabs with Shared with me selected first', async ({ page }) => {
    await openProfile(page)
    await expect(sectionOf(page, 'Connections').getByRole('tablist', { name: 'Connections' })).toBeVisible()
    await expect(sectionOf(page, 'Connections').getByRole('tab')).toHaveText(['Shared with me', 'My connections'])
    await expect(connectionsTabOf(page, 'Shared with me')).toHaveAttribute('aria-selected', 'true')
  })

  test('switches tabs with the mouse and the arrow keys', async ({ page }) => {
    await openProfile(page)
    await connectionsTabOf(page, 'My connections').click()
    await expect(connectionsPanelOf(page)).toContainText('GitHub')
    await expect(connectionsPanelOf(page)).not.toContainText('2 of 5 tables')

    await connectionsTabOf(page, 'Shared with me').focus()
    await page.keyboard.press('ArrowRight')
    await expect(connectionsTabOf(page, 'My connections')).toBeFocused()
    await expect(connectionsTabOf(page, 'My connections')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(connectionsTabOf(page, 'Shared with me')).toHaveAttribute('aria-selected', 'true')
  })

  test('lists the shared connections with the access of the member, read-only', async ({ page }) => {
    await openProfile(page)
    const sharedSection = connectionsPanelOf(page)
    await expect(sharedSection.getByRole('listitem').filter({ hasText: 'Postgres' })).toContainText('2 of 5 tables')
    await expect(sharedSection.getByRole('listitem').filter({ hasText: 'Onyx' })).toContainText('All sources')
    await expect(sharedSection.getByRole('button')).toHaveCount(0)
  })
})

test.describe('8. personal connections', () => {
  const personalSectionOf = connectionsPanelOf

  test('lists the connections with their status and the matching actions', async ({ page }) => {
    await openProfile(page)
    await openMyConnections(page)
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
    await openMyConnections(page)
    await personalSectionOf(page).getByRole('button', { name: 'Reconnect Notion' }).click()
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).toContainText('Connected')
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).not.toContainText(
      'Needs reconnection',
    )
    await expect(personalSectionOf(page).getByRole('button', { name: 'Reconnect Notion' })).toHaveCount(0)
  })

  test('connects a tool of the catalog', async ({ page }) => {
    await openProfile(page)
    await openMyConnections(page)
    await personalSectionOf(page).getByRole('button', { name: 'Connect Linear', exact: true }).click()
    await expect(personalSectionOf(page).getByRole('listitem').filter({ hasText: 'Linear' })).toContainText('Connected')
    await expect(personalSectionOf(page).getByRole('button', { name: 'Connect Linear', exact: true })).toHaveCount(0)
  })

  test('disconnects a tool and offers to connect it again', async ({ page }) => {
    await openProfile(page)
    await openMyConnections(page)
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
    await openMyConnections(page)
    await connectionsPanelOf(page).getByRole('button', { name: 'Disconnect GitHub' }).click()

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
    for (const sectionName of ['LLM access', 'Connections']) {
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
