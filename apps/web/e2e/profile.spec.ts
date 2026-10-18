import {
  addCredential,
  blockedNotice,
  composerOf,
  expect,
  type Locator,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  openChat,
  openPanelTab,
  openProfile,
  type Page,
  panelTabOf,
  sendButtonOf,
  tabPanelOf,
  test,
} from './fixtures'

const sectionOf = (page: Page, sectionName: string) => mainOf(page).getByRole('region', { name: sectionName })
const credentialRowOf = (page: Page, provider: string) =>
  llmSectionOf(page).getByRole('listitem').filter({ hasText: provider })

const connectionsTabOf = (page: Page, tabName: 'Shared with me' | 'My connections') =>
  sectionOf(page, 'Connections').getByRole('tab', { name: tabName })
const connectionsPanelOf = (page: Page) => sectionOf(page, 'Connections').getByRole('tabpanel')
const openMyConnections = async (page: Page) => {
  await connectionsTabOf(page, 'My connections').click()
  await expect(connectionsTabOf(page, 'My connections')).toHaveAttribute('aria-selected', 'true')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('shows the profile without changing it', async ({ page }) => {
  await openProfile(page)

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

  await test.step('shows the credential masked, without the full secret anywhere', async () => {
    await expect(credentialRowOf(page, 'Anthropic')).toContainText('••••a1b2')
  })

  await test.step('has only the Provider and Secret fields: no Label, Kind or Credential kind switch', async () => {
    for (const removedField of ['Label', 'Kind', 'Credential']) {
      await expect(llmSectionOf(page).getByLabel(removedField)).toHaveCount(0)
    }
    await expect(llmSectionOf(page).getByText(/Plan/)).toHaveCount(0)
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

  await test.step('shows the two tabs with Shared with me selected first', async () => {
    await expect(sectionOf(page, 'Connections').getByRole('tablist', { name: 'Connections' })).toBeVisible()
    await expect(sectionOf(page, 'Connections').getByRole('tab')).toHaveText(['Shared with me', 'My connections'])
    await expect(connectionsTabOf(page, 'Shared with me')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('lists the shared connections with the tools of the member, read-only', async () => {
    const sharedSection = connectionsPanelOf(page)
    await expect(sharedSection.getByRole('listitem')).toHaveText(['CRMlookup, update'])
    await expect(sharedSection.getByRole('button')).toHaveCount(0)
  })

  await test.step('switches tabs with the mouse and the arrow keys', async () => {
    await connectionsTabOf(page, 'My connections').click()
    await expect(connectionsPanelOf(page)).toContainText('GitHub')
    await expect(connectionsPanelOf(page)).not.toContainText('lookup, update')
    await connectionsTabOf(page, 'Shared with me').focus()
    await page.keyboard.press('ArrowRight')
    await expect(connectionsTabOf(page, 'My connections')).toBeFocused()
    await expect(connectionsTabOf(page, 'My connections')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(connectionsTabOf(page, 'Shared with me')).toHaveAttribute('aria-selected', 'true')
  })

  await test.step('lists the connections with their status and the matching actions', async () => {
    await openMyConnections(page)
    const personalSection = connectionsPanelOf(page)
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'GitHub' })).toContainText('Connected')
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'Slack' })).toContainText('Connected')
    await expect(personalSection.getByRole('listitem').filter({ hasText: 'Notion' })).toContainText(
      'Needs reconnection',
    )
    await expect(personalSection.getByRole('button', { name: 'Disconnect GitHub' })).toBeVisible()
    await expect(personalSection.getByRole('button', { name: 'Reconnect Notion' })).toBeVisible()
    await expect(personalSection.getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible()
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

  await test.step('does not block when a credential exists', async () => {
    await openChat(page, 'Research')
    await expect(mainOf(page)).not.toContainText(blockedNotice)
    await composerOf(page).fill('Allowed')
    await expect(sendButtonOf(page)).toBeEnabled()
  })
})

test('adds API keys below the form, masked and aligned', async ({ page }) => {
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
})

test('removes the only key, which blocks prompting in runtime chats until a key is added', async ({ page }) => {
  await openProfile(page)

  await test.step('removes the credential after confirmation and shows the empty state', async () => {
    await llmSectionOf(page).getByRole('button', { name: 'Remove Anthropic' }).click()
    await expect(page.getByRole('dialog', { name: 'Remove LLM key' })).toContainText('Anthropic')
    await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
    await expect(credentialRowOf(page, 'Anthropic')).toHaveCount(0)
    await expect(llmSectionOf(page)).toContainText('No LLM keys yet')
  })

  await test.step('shows the empty message below the form', async () => {
    const addButtonBox = (await llmSectionOf(page).getByRole('button', { name: 'Add' }).boundingBox())!
    const emptyMessageBox = (await llmSectionOf(page).getByText('No LLM keys yet').boundingBox())!
    expect(addButtonBox.y + addButtonBox.height).toBeLessThan(emptyMessageBox.y)
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

test('changes personal connections and the panel follows', async ({ page }) => {
  await openProfile(page)
  await openMyConnections(page)

  await test.step('reconnects a tool that needs reconnection', async () => {
    await connectionsPanelOf(page).getByRole('button', { name: 'Reconnect Notion' }).click()
    await expect(connectionsPanelOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).toContainText(
      'Connected',
    )
    await expect(connectionsPanelOf(page).getByRole('listitem').filter({ hasText: 'Notion' })).not.toContainText(
      'Needs reconnection',
    )
    await expect(connectionsPanelOf(page).getByRole('button', { name: 'Reconnect Notion' })).toHaveCount(0)
  })

  await test.step('connects a tool of the catalog', async () => {
    await connectionsPanelOf(page).getByRole('button', { name: 'Connect Linear', exact: true }).click()
    await expect(connectionsPanelOf(page).getByRole('listitem').filter({ hasText: 'Linear' })).toContainText(
      'Connected',
    )
    await expect(connectionsPanelOf(page).getByRole('button', { name: 'Connect Linear', exact: true })).toHaveCount(0)
  })

  await test.step('disconnects a tool and offers to connect it again', async () => {
    await connectionsPanelOf(page).getByRole('button', { name: 'Disconnect GitHub' }).click()
    await expect(connectionsPanelOf(page).getByRole('listitem').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(connectionsPanelOf(page).getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
  })

  await test.step('reflects a disconnection made in the profile', async () => {
    await openPanelTab(page, 'Invoice bug', 'Connected tools')
    const personalGroup = tabPanelOf(page).getByRole('region', { name: 'Personal' })
    await expect(personalGroup.getByRole('listitem').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(personalGroup.getByRole('listitem').filter({ hasText: 'Slack' })).toBeVisible()
  })
})

test('saves the new display name and shows it everywhere', async ({ page }) => {
  await openProfile(page)
  await sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' }).fill('Alice D.')
  await sectionOf(page, 'Display name').getByRole('button', { name: 'Save' }).click()
  await expect(sectionOf(page, 'Display name').getByText('Saved')).toBeVisible()

  await openChat(page, 'Welcome')
  await expect(messageItemsOf(page).nth(1)).toContainText('Alice D.')

  await openChat(page, 'Invoice bug')
  await expect(mainOf(page).getByText('Agent acts as')).toContainText('Alice D.')
  await panelTabOf(page, 'Usage').click()
  await expect(tabPanelOf(page).getByRole('row', { name: /Alice D\./ })).toBeVisible()
  await panelTabOf(page, 'Members').click()
  await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'Alice D.' })).toContainText('Owner')
})
