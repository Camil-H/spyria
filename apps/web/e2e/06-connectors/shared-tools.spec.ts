import { openPageAs, type WorkerStack } from '../stack'
import { fakeMcpUrl } from '../stack-ports'
import {
  addLlmKey,
  addParticipant,
  connectionsOf,
  expect,
  type Locator,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  openChat,
  openPanelTab,
  openProfile,
  openSettings,
  type Page,
  research,
  sendMessage,
  tabPanelOf,
  test,
  workingIndicatorOf,
} from './fixtures'

test.describe('Shared tools', () => {
  test.use({ sharedCrm: false })
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  const crmUrl = `http://host.docker.internal:${new URL(fakeMcpUrl).port}/shared/mcp`
  const settingsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Connections' })
  const crmCardOf = (page: Page) =>
    settingsSectionOf(page).getByRole('list', { name: 'Workspace connections' }).getByRole('listitem', { name: 'CRM' })
  const notOffered = (gatewayName: string, tool: string) => `Tool ${gatewayName}-${tool} not found`

  const registerCrm = async (page: Page, workerStack: WorkerStack) => {
    await openSettings(page, 'MCP tools')
    const form = settingsSectionOf(page).getByRole('form', { name: 'Add connection' })
    await form.getByLabel('Name').fill('CRM')
    await form.getByLabel('MCP URL').fill(crmUrl)
    await form.getByLabel('Secret header').fill('x-crm-key')
    await form.getByLabel('Secret value').fill('crm-e2e-secret')
    await form.getByRole('button', { name: 'Add connection' }).click()
    await expect(crmCardOf(page)).toBeVisible()
    const [row] = await workerStack.database.$client<{ gatewayName: string }[]>`
    select gateway_name as "gatewayName" from workspace_connections where name = 'CRM'`
    return row?.gatewayName ?? ''
  }
  const toolScriptOf = (gatewayName: string, tool: string, text: string) => ({
    steps: [{ tool: `${gatewayName}-${tool}`, arguments: {} }],
    text,
    stepName: `Used ${tool} (${gatewayName})`,
  })
  const giveResearchToBob = async (workerStack: WorkerStack) => {
    await workerStack.database.$client.begin(async (sql) => {
      await sql`update chats set owner_user_id = 'member-bob' where id = ${research}`
      await sql`update chat_participants set role_id = 'prompter' where chat_id = ${research} and user_id = 'member-alice'`
      await sql`
      insert into chat_participants (workspace_id, chat_id, user_id, role_id)
      values ('workspace-acme', ${research}, 'member-bob', 'owner')`
    })
  }
  const openAsBobWithKey = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Fake')
    return bobPage
  }
  const promptIn = async (
    page: Page,
    agentScript: (chat: string, script: object) => Promise<void>,
    { stepName, ...script }: ReturnType<typeof toolScriptOf>,
    text: string,
  ) => {
    await agentScript(research, script)
    await openChat(page, 'Research')
    await sendMessage(page, text)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await messageItemsOf(page).getByRole('button', { name: stepName }).last().click()
    return messageItemsOf(page)
      .filter({ has: page.getByRole('button', { name: stepName, expanded: true }) })
      .last()
  }
  const untick = async (checkbox: Locator) => {
    await checkbox.click()
    await expect(checkbox).not.toBeChecked()
  }
  const restrictFor = (page: Page, memberName: string, tool: string) =>
    untick(crmCardOf(page).getByRole('checkbox', { name: `${tool} for ${memberName}` }))
  const sharedWithMeOf = async (page: Page) => {
    await openProfile(page)
    return connectionsOf(page).getByRole('tabpanel')
  }

  test('As a member who can manage MCP tools, I register CRM with a secret header: its tools are listed, the secret shows only as set, and Bob sees it shared with him and his agent uses it', {
    tag: ['@spec-38', '@smoke'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await expect(crmCardOf(page)).toContainText('x-crm-key: set')
    await expect(crmCardOf(page)).not.toContainText('crm-e2e-secret')
    const tools = crmCardOf(page).getByRole('group', { name: 'Tools of CRM' })
    await expect(tools).toContainText('lookupread-only')
    await expect(tools).toContainText('updatewrites')
    await expect(tools.getByRole('checkbox', { name: /^lookup/ })).toBeChecked()
    await expect(tools.getByRole('checkbox', { name: /^update/ })).toBeChecked()

    await giveResearchToBob(workerStack)
    const bobPage = await openAsBobWithKey(browser, workerStack)
    await expect((await sharedWithMeOf(bobPage)).getByRole('listitem')).toHaveText(['CRMlookup, update'])
    const result = await promptIn(bobPage, agentScript, toolScriptOf(gatewayName, 'lookup', 'Found it.'), 'Look it up')
    await expect(result).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage MCP tools, I restrict Bob to lookup and his update is refused, also after he removes and re-adds his LLM key', {
    tag: ['@spec-38'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await restrictFor(page, 'Bob', 'update')
    await giveResearchToBob(workerStack)
    const bobPage = await openAsBobWithKey(browser, workerStack)
    const update = toolScriptOf(gatewayName, 'update', 'Tried to update.')
    await expect(await promptIn(bobPage, agentScript, update, 'Update it')).toContainText(
      notOffered(gatewayName, 'update'),
    )

    await openProfile(bobPage)
    await llmSectionOf(bobPage).getByRole('button', { name: 'Remove Fake' }).click()
    await bobPage.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
    await expect
      .poll(
        async () =>
          (await workerStack.database.$client`select 1 from member_gateway_keys where user_id = 'member-bob'`).length,
      )
      .toBe(0)
    await addLlmKey(bobPage, 'Fake')
    await expect(await promptIn(bobPage, agentScript, update, 'Update it again')).toContainText(
      notOffered(gatewayName, 'update'),
    )
    const lookup = toolScriptOf(gatewayName, 'lookup', 'Looked it up.')
    await expect(await promptIn(bobPage, agentScript, lookup, 'Look it up')).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage MCP tools, I restrict a chat owner from update and a guest’s prompt in her chat cannot use it either, while lookup works', {
    tag: ['@spec-38'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await restrictFor(page, 'Alice', 'update')
    await addParticipant(workerStack, research, 'member-bob', 'prompter')
    const bobPage = await openAsBobWithKey(browser, workerStack)
    const update = toolScriptOf(gatewayName, 'update', 'Tried to update.')
    await expect(await promptIn(bobPage, agentScript, update, 'Update it')).toContainText(
      notOffered(gatewayName, 'update'),
    )
    const lookup = toolScriptOf(gatewayName, 'lookup', 'Looked it up.')
    await expect(await promptIn(bobPage, agentScript, lookup, 'Look it up')).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage MCP tools, I untick update for the workspace: it is refused on every prompt and the Connected tools tab shows CRM with lookup only', {
    tag: ['@spec-38'],
  }, async ({ page, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    const update = crmCardOf(page)
      .getByRole('group', { name: 'Tools of CRM' })
      .getByRole('checkbox', { name: /^update/ })
    await untick(update)
    await expect(
      await promptIn(page, agentScript, toolScriptOf(gatewayName, 'update', 'Tried to update.'), 'Update it'),
    ).toContainText(notOffered(gatewayName, 'update'))
    await openPanelTab(page, 'Research', 'Connected tools')
    const workspaceGroup = tabPanelOf(page).getByRole('region', { name: 'Workspace' })
    await expect(workspaceGroup.getByRole('listitem')).toHaveText(['CRMlookup'])
  })

  test('As a member who can manage MCP tools, I remove CRM: it leaves Shared with me and the Connected tools tab, and its calls are refused', {
    tag: ['@spec-38'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const bobShared = await sharedWithMeOf(bobPage)
    await expect(bobShared.getByRole('listitem')).toHaveText(['CRMlookup, update'])

    await crmCardOf(page).getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('dialog', { name: 'Remove connection' }).getByRole('button', { name: 'Remove' }).click()
    await expect(settingsSectionOf(page)).toContainText('No workspace connections')
    await expect(bobShared).toContainText('No shared connections')
    await openPanelTab(page, 'Research', 'Connected tools')
    await expect(tabPanelOf(page).getByRole('region', { name: 'Workspace' })).toContainText('No workspace connections')
    await expect(
      await promptIn(page, agentScript, toolScriptOf(gatewayName, 'lookup', 'Tried to look it up.'), 'Look it up'),
    ).toContainText(notOffered(gatewayName, 'lookup'))
    await expect(messageItemsOf(page).filter({ hasText: 'ran lookup' })).toHaveCount(0)
    await bobPage.context().close()
  })
})
