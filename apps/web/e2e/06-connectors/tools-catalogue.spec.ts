import { openPageAs, type WorkerStack } from '../stack'
import { fakeMcpUrl } from '../stack-ports'
import {
  accountOf,
  addLlmKey,
  addParticipant,
  approvalsOf,
  chooseConnectionAction,
  connectionsOf,
  expect,
  githubSectionOf,
  inPopup,
  type Locator,
  llmSectionOf,
  logInAtFakeProvider,
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

test.describe('Tools catalogue', () => {
  test.use({ sharedCrm: false })
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  const crmUrl = `http://host.docker.internal:${new URL(fakeMcpUrl).port}/shared/mcp`
  const settingsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Servers' })
  const serverCardOf = (page: Page, name: string) =>
    settingsSectionOf(page).getByRole('list', { name: 'Servers' }).getByRole('listitem', { name })
  const crmCardOf = (page: Page) => serverCardOf(page, 'CRM')
  const notOffered = (serverName: string, tool: string) => `Tool ${serverName}-${tool} not found`

  const afterSaving = async (page: Page, action: () => Promise<unknown>) => {
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/workspace-connections\/[^/]+\/(access|review)$/.test(new URL(response.url()).pathname),
    )
    await action()
    expect((await saved).ok()).toBe(true)
  }
  const setLevel = async (page: Page, who: string, level: string, serverName = 'CRM') => {
    const select = serverCardOf(page, serverName).getByRole('combobox', { name: `Access of ${who}` })
    await afterSaving(page, () => select.selectOption({ label: level }))
    await expect(select.locator('option:checked')).toHaveText(level)
  }
  const confirmTools = async (page: Page, serverName: string) => {
    await afterSaving(page, () => serverCardOf(page, serverName).getByRole('button', { name: 'Confirm' }).click())
    await expect(serverCardOf(page, serverName).getByRole('region', { name: `Access to ${serverName}` })).toBeVisible()
  }
  const addNamedMember = async (page: Page, who: string) => {
    await crmCardOf(page)
      .getByRole('combobox', { name: /own access replaces/ })
      .selectOption({ label: who })
    await expect(crmCardOf(page).getByRole('combobox', { name: `Access of ${who}` })).toBeVisible()
  }
  const registerCrm = async (page: Page, workerStack: WorkerStack) => {
    const gatewayName = await addCrm(page, workerStack)
    await confirmTools(page, 'CRM')
    await setLevel(page, 'Admin', 'Read and write')
    await setLevel(page, 'Member', 'Read and write')
    return gatewayName
  }
  const addCrm = async (page: Page, workerStack: WorkerStack) => {
    await openSettings(page, 'Tools')
    const form = settingsSectionOf(page).getByRole('form', { name: 'Add server' })
    await form.getByLabel('Name').fill('CRM')
    await form.getByLabel('Address').fill(crmUrl)
    await form.getByRole('radio', { name: 'One shared login' }).check()
    await form.getByLabel('Secret header').fill('x-crm-key')
    await form.getByLabel('Secret value').fill('crm-e2e-secret')
    await form.getByRole('button', { name: 'Add server' }).click()
    await expect(crmCardOf(page)).toBeVisible()
    const [row] = await workerStack.database.$client<{ gatewayName: string }[]>`
    select gateway_name as "gatewayName" from workspace_connections where name = 'CRM'`
    return row?.gatewayName ?? ''
  }
  const toolScriptOf = (gatewayName: string, tool: string, text: string, serverName = 'CRM') => ({
    steps: [{ tool: `${gatewayName}-${tool}`, arguments: {} }],
    text,
    stepName: `Used ${tool} (${serverName})`,
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
    await addLlmKey(bobPage, 'Mistral')
    return bobPage
  }
  const toolGrantsSynced = (workerStack: WorkerStack) =>
    expect
      .poll(async () => {
        const [gatewaySync] = await workerStack.database.$client<{ isPending: boolean }[]>`
          select exists(select 1 from jobs where type = 'profile.gateway-sync' and state in ('queued', 'running'))
            as "isPending"`
        return gatewaySync?.isPending
      })
      .toBe(false)
  const promptIn = async (
    workerStack: WorkerStack,
    page: Page,
    agentScript: (chat: string, script: object) => Promise<void>,
    { stepName, ...script }: ReturnType<typeof toolScriptOf>,
    text: string,
  ) => {
    await toolGrantsSynced(workerStack)
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
  const profileCrmOf = async (page: Page) => {
    await openProfile(page, 'Connections')
    return connectionsOf(page).getByRole('listitem', { name: 'CRM' })
  }

  test('As a member who can manage the tools catalogue, I register CRM with a secret header, confirm what its tools do and open it to every role: the secret shows only as set, and Bob sees it in his tool connections and his agent uses it', {
    tag: ['@spec-38', '@spec-58', '@smoke'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await addCrm(page, workerStack)
    await expect(crmCardOf(page)).toContainText('One shared login, x-crm-key: set')
    await expect(crmCardOf(page)).not.toContainText('crm-e2e-secret')
    await expect(crmCardOf(page)).toContainText('2 tools · 1 read · 1 write')
    const review = crmCardOf(page).getByRole('region', { name: 'Read and write of CRM' })
    await expect(review.getByRole('combobox', { name: 'What lookup does' })).toHaveValue('read')
    await expect(review.getByRole('combobox', { name: 'What update does' })).toHaveValue('write')
    await expect(crmCardOf(page).getByRole('region', { name: 'Access to CRM' })).toHaveCount(0)
    await confirmTools(page, 'CRM')
    await setLevel(page, 'Admin', 'Read and write')
    await setLevel(page, 'Member', 'Read and write')

    await giveResearchToBob(workerStack)
    const bobPage = await openAsBobWithKey(browser, workerStack)
    await expect(await profileCrmOf(bobPage)).toContainText('Shared login: 2 tools · 1 read · 1 write')
    const result = await promptIn(
      workerStack,
      bobPage,
      agentScript,
      toolScriptOf(gatewayName, 'lookup', 'Found it.'),
      'Look it up',
    )
    await expect(result).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage the tools catalogue, I register CRM while a chat’s agent is running, and its next prompt uses CRM without a restart', {
    tag: ['@spec-38'],
  }, async ({ page, workerStack, agentScript }) => {
    await agentScript(research, { text: 'Ready.' })
    await openChat(page, 'Research')
    await sendMessage(page, 'Get ready')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    const gatewayName = await registerCrm(page, workerStack)
    const lookup = toolScriptOf(gatewayName, 'lookup', 'Looked it up.')
    await expect(await promptIn(workerStack, page, agentScript, lookup, 'Look it up')).toContainText('ran lookup')
  })

  test('As a member who can manage the tools catalogue, I give Bob his own Read access and his update is refused, also after he removes his LLM key and adds it again', {
    tag: ['@spec-38', '@spec-58'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await addNamedMember(page, 'Bob')
    await setLevel(page, 'Bob', 'Read')
    await giveResearchToBob(workerStack)
    const bobPage = await openAsBobWithKey(browser, workerStack)
    const update = toolScriptOf(gatewayName, 'update', 'Tried to update.')
    await expect(await promptIn(workerStack, bobPage, agentScript, update, 'Update it')).toContainText(
      notOffered('CRM', 'update'),
    )

    await openProfile(bobPage, 'LLM keys')
    await llmSectionOf(bobPage).getByRole('button', { name: 'Remove Mistral' }).click()
    await bobPage.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
    await expect
      .poll(async () => {
        const [row] = await workerStack.database.$client`
          select virtual_key_id from member_gateway_keys where user_id = 'member-bob'`
        const { virtual_key } = await workerStack.gateway<{ virtual_key: { provider_configs: unknown[] | null } }>(
          `/api/governance/virtual-keys/${row?.virtual_key_id}`,
        )
        return virtual_key.provider_configs?.length ?? 0
      })
      .toBe(0)
    await addLlmKey(bobPage, 'Mistral')
    await expect(await promptIn(workerStack, bobPage, agentScript, update, 'Update it again')).toContainText(
      notOffered('CRM', 'update'),
    )
    const lookup = toolScriptOf(gatewayName, 'lookup', 'Looked it up.')
    await expect(await promptIn(workerStack, bobPage, agentScript, lookup, 'Look it up')).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage the tools catalogue, I give a chat owner Read only and a guest’s prompt in her chat cannot use update either, while lookup works', {
    tag: ['@spec-38', '@spec-58'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await addNamedMember(page, 'Alice')
    await setLevel(page, 'Alice', 'Read')
    await addParticipant(workerStack, research, 'member-bob', 'prompter')
    const bobPage = await openAsBobWithKey(browser, workerStack)
    const update = toolScriptOf(gatewayName, 'update', 'Tried to update.')
    await expect(await promptIn(workerStack, bobPage, agentScript, update, 'Update it')).toContainText(
      "CRM isn't available on Bob's prompts in this chat",
    )
    const lookup = toolScriptOf(gatewayName, 'lookup', 'Looked it up.')
    await expect(await promptIn(workerStack, bobPage, agentScript, lookup, 'Look it up')).toContainText('ran lookup')
    await bobPage.context().close()
  })

  test('As a member who can manage the tools catalogue, I untick update in the Admin role’s tool list: it is refused on my prompts and the Connected tools tab shows CRM with lookup only', {
    tag: ['@spec-38', '@spec-58'],
  }, async ({ page, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    const adminRow = crmCardOf(page).getByRole('list', { name: 'Roles' }).getByRole('listitem', { name: 'Admin' })
    await adminRow.getByRole('button', { name: 'Single tools' }).click()
    await adminRow.getByRole('searchbox', { name: 'Search tools for Admin' }).fill('upd')
    await expect(adminRow.getByRole('checkbox', { name: 'lookup for Admin' })).toHaveCount(0)
    await afterSaving(page, () => untick(adminRow.getByRole('checkbox', { name: 'update for Admin' })))
    await expect(adminRow.getByRole('button', { name: '1 single change' })).toBeVisible()
    await expect(adminRow.getByRole('switch', { name: 'Allow all write tools' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await expect(
      await promptIn(
        workerStack,
        page,
        agentScript,
        toolScriptOf(gatewayName, 'update', 'Tried to update.'),
        'Update it',
      ),
    ).toContainText(notOffered('CRM', 'update'))
    await openPanelTab(page, 'Research', 'Connected tools')
    await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'CRM' })).toHaveText(['CRMlookup'])
  })

  test('As the owner of a chat, I switch CRM off in its Connected tools tab: the agent no longer has its tools in that chat until I switch it back on', {
    tag: ['@spec-59'],
  }, async ({ page, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    await expect(
      await promptIn(
        workerStack,
        page,
        agentScript,
        toolScriptOf(gatewayName, 'lookup', 'Looked it up.'),
        'Look it up first',
      ),
    ).toContainText('ran lookup')
    await openPanelTab(page, 'Research', 'Connected tools')
    const crmSwitch = tabPanelOf(page).getByRole('switch', { name: 'CRM' })
    await expect(crmSwitch).toHaveAttribute('aria-checked', 'true')
    await crmSwitch.click()
    await expect(crmSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'CRM' })).toHaveText(['CRMOff in this chat'])
    await expect(
      await promptIn(
        workerStack,
        page,
        agentScript,
        toolScriptOf(gatewayName, 'lookup', 'Tried to look it up.'),
        'Look it up',
      ),
    ).toContainText(new RegExp(`CRM is off for this chat|${notOffered('CRM', 'lookup')}`))
    await expect(messageItemsOf(page).filter({ hasText: 'ran lookup' })).toHaveCount(1)

    await openPanelTab(page, 'Research', 'Connected tools')
    await crmSwitch.click()
    await expect(crmSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(
      await promptIn(
        workerStack,
        page,
        agentScript,
        toolScriptOf(gatewayName, 'lookup', 'Looked it up.'),
        'Look it up again',
      ),
    ).toContainText('ran lookup')
  })

  test('As a member who can manage the tools catalogue, I remove CRM: it leaves members’ tool connections and the Connected tools tab, and its calls are refused', {
    tag: ['@spec-38'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const gatewayName = await registerCrm(page, workerStack)
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const bobCrm = await profileCrmOf(bobPage)
    await expect(bobCrm).toContainText('Shared login: 2 tools · 1 read · 1 write')

    await crmCardOf(page).getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('dialog', { name: 'Remove server' }).getByRole('button', { name: 'Remove' }).click()
    await expect(crmCardOf(page)).toHaveCount(0)
    await expect(bobCrm).toHaveCount(0)
    await openPanelTab(page, 'Research', 'Connected tools')
    await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'CRM' })).toHaveCount(0)
    await expect(
      await promptIn(
        workerStack,
        page,
        agentScript,
        toolScriptOf(gatewayName, 'lookup', 'Tried to look it up.', gatewayName),
        'Look it up',
      ),
    ).toContainText(notOffered(gatewayName, 'lookup'))
    await expect(messageItemsOf(page).filter({ hasText: 'ran lookup' })).toHaveCount(0)
    await bobPage.context().close()
  })
  test('As a member who can manage the tools catalogue, I add a server each member signs in to: I sign in once so its tools are listed, then Bob connects his own account from his tool connections', {
    tag: ['@spec-38'],
  }, async ({ page, browser, workerStack }) => {
    await logInAtFakeProvider(page.context(), accountOf('alice-admin'))
    await openSettings(page, 'Tools')
    const form = settingsSectionOf(page).getByRole('form', { name: 'Add server' })
    await form.getByLabel('Name').fill('Docs')
    await form.getByLabel('Address').fill(`http://host.docker.internal:${new URL(fakeMcpUrl).port}/mcp`)
    await expect(form.getByRole('radio', { name: 'Each member signs in' })).toBeChecked()
    await expect(form.getByLabel('Secret value')).toHaveCount(0)
    await inPopup(page, () => form.getByRole('button', { name: 'Add server' }).click())
    await expect(serverCardOf(page, 'Docs')).toContainText('Each member signs in')
    await expect(serverCardOf(page, 'Docs').getByRole('combobox', { name: 'What whoami does' })).toHaveValue('read')
    await confirmTools(page, 'Docs')
    await setLevel(page, 'Member', 'Read', 'Docs')

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const bobAccount = accountOf('bob')
    await logInAtFakeProvider(bobPage.context(), bobAccount)
    await openProfile(bobPage, 'Connections')
    const docsRow = connectionsOf(bobPage).getByRole('listitem', { name: 'Docs' })
    await expect(docsRow).toContainText('Not connected')
    await inPopup(bobPage, () => docsRow.getByRole('button', { name: 'Connect Docs' }).click())
    await expect(docsRow).toContainText('Connected')
    await docsRow.getByRole('button', { name: 'Actions for Docs' }).click()
    await expect(bobPage.getByRole('menuitem', { name: 'Disconnect' })).toBeVisible()
    await bobPage.context().close()
  })

  test('As a member who can manage the tools catalogue, I find Spyria’s built-in tools with what they do and nothing to edit, and GitHub as a server with a level per role, linked both ways with Connect GitHub', {
    tag: ['@spec-58'],
  }, async ({ page, browser, workerStack }) => {
    await openSettings(page, 'Tools')

    await test.step('lists the built-in tools with what they do, nothing to edit, and the quality gates’ tools set in Quality gates', async () => {
      const builtIn = mainOf(page).getByRole('region', { name: 'Built in' })
      await expect(builtIn.getByRole('list', { name: 'Built-in tools' }).getByRole('listitem')).toHaveCount(8)
      await expect(builtIn).toContainText(
        "open_pageOpens a web page or a file of the project in the chat's Browser tab",
      )
      await expect(builtIn.getByRole('button')).toHaveCount(0)
      await expect(builtIn.getByRole('combobox')).toHaveCount(0)
      await builtIn.getByRole('link', { name: 'Set in Quality gates' }).first().click()
      await expect(page).toHaveURL(/\/settings\/quality-gates$/)
    })

    await openSettings(page, 'Tools')
    const github = serverCardOf(page, 'GitHub')
    await test.step('shows GitHub among the servers, every role on Read and write until set, with nothing to edit or remove', async () => {
      await expect(github).toContainText('8 tools · 5 read · 3 write')
      await expect(github.getByRole('combobox', { name: 'Access of Member' }).locator('option:checked')).toHaveText(
        'Read and write',
      )
      await expect(github.getByRole('button', { name: 'Edit' })).toHaveCount(0)
      await expect(github.getByRole('button', { name: 'Remove' })).toHaveCount(0)
    })

    await test.step('gives the Member role Read on GitHub, so a member chooses approvals for its read tools only', async () => {
      await setLevel(page, 'Member', 'Read', 'GitHub')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await openProfile(bobPage, 'Connections')
      await chooseConnectionAction(bobPage, 'GitHub', 'Approvals')
      const approvals = approvalsOf(bobPage, 'GitHub')
      await expect(approvals.getByRole('combobox', { name: 'Approval for read_checks' })).toBeVisible()
      await expect(approvals.getByRole('combobox', { name: 'Approval for push_branch' })).toHaveCount(0)
      await bobPage.context().close()
    })

    await test.step('links to Connect GitHub for its setup, which links back to Tools', async () => {
      await github.getByRole('link', { name: 'Set up in Connect GitHub' }).click()
      await expect(page).toHaveURL(/\/settings\/github$/)
      await githubSectionOf(page).getByRole('link', { name: 'Tools', exact: true }).click()
      await expect(page).toHaveURL(/\/settings\/tools$/)
    })
  })
})
