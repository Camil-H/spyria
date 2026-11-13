import type { WorkerStack } from '../stack'
import { fakeMcpUrl, gatewayUrl } from '../stack-ports'
import {
  accountOf,
  addLlmKey,
  approvalsOf,
  chooseConnectionAction,
  connectFake,
  connectionsOf,
  expect,
  fakeRowOf,
  inPopup,
  lastToolResultOf,
  logInAtFakeProvider,
  mainOf,
  messageItemsOf,
  openMyConnections,
  openPanelTab,
  openProfile,
  type Page,
  promptTool,
  tabPanelOf,
  test,
  toolStepsOf,
} from './fixtures'

const whoamiThroughGateway = async (workerStack: WorkerStack, workspace: string) => {
  const [row] = await workerStack.database.$client`
    select virtual_key_id from member_gateway_keys where workspace_id = ${workspace} and user_id = 'member-alice'`
  const { virtual_key } = await workerStack.gateway<{ virtual_key: { value: string } }>(
    `/api/governance/virtual-keys/${row?.virtual_key_id}`,
  )
  const gatewayName = workspace === 'workspace-acme' ? 'fake' : 'fakeglobex'
  const response = await fetch(`${gatewayUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${virtual_key.value}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: `${gatewayName}-whoami`, arguments: {} },
    }),
  })
  return JSON.stringify(await response.json())
}

const toolRowOf = (page: Page, name: string) =>
  connectionsOf(page)
    .getByRole('list', { name: 'Your accounts and tools' })
    .getByRole('listitem', { name, exact: true })

test.describe('Tool connections', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see the workspace’s tools in one list: a shared login with the tools I may use, and each server I sign in to with its status and Connect', async ({
    page,
  }) => {
    await openProfile(page, 'Connections')

    await test.step('lists my GitHub account and every tool of the catalogue, without tabs', async () => {
      await expect(connectionsOf(page).getByRole('listitem', { name: 'GitHub account' })).toBeVisible()
      await expect(connectionsOf(page).getByRole('tab')).toHaveCount(0)
    })

    await test.step('shows the shared-login server with the count of my tools, nothing to connect and my approvals', async () => {
      await expect(toolRowOf(page, 'CRM')).toHaveText('CRMShared login · 2 tools · 1 read · 1 write')
      await expect(toolRowOf(page, 'CRM').getByRole('button')).toHaveCount(1)
      await toolRowOf(page, 'CRM').getByRole('button', { name: 'Actions for CRM' }).click()
      await expect(page.getByRole('menuitem')).toHaveText(['Approvals'])
      await page.keyboard.press('Escape')
    })

    await test.step('shows each server I sign in to as not connected, with Connect and nothing to disconnect', async () => {
      for (const tool of ['Figma', 'Slack', 'Notion', 'Linear', 'fake']) {
        await expect(toolRowOf(page, tool)).toContainText('Not connected')
        await expect(toolRowOf(page, tool).getByRole('button', { name: `Connect ${tool}`, exact: true })).toBeVisible()
      }
      await expect(connectionsOf(page).getByRole('button', { name: /^Reconnect / })).toHaveCount(0)
      await toolRowOf(page, 'Linear').getByRole('button', { name: 'Actions for Linear' }).click()
      await expect(page.getByRole('menuitem')).toHaveText(['Approvals'])
      await page.keyboard.press('Escape')
    })
  })

  test('As a member, I choose approvals for a shared-login server by kind of tool: all its read tools at once, and only my changes on demand', async ({
    page,
  }) => {
    await openProfile(page, 'Connections')
    await chooseConnectionAction(page, 'CRM', 'Approvals')
    const approvals = approvalsOf(page, 'CRM')
    const lookupApproval = approvals.getByRole('combobox', { name: 'Approval for lookup' })

    await test.step('opens on the write tools, with a tab per kind of tool and its count', async () => {
      await expect(approvals.getByRole('tab')).toHaveText(['Read 1', 'Write 1'])
      await expect(approvals.getByRole('tab', { name: 'Write 1' })).toHaveAttribute('aria-selected', 'true')
      await expect(
        approvals
          .getByRole('radiogroup', { name: 'Write tools of CRM' })
          .getByRole('radio', { name: "On a guest's prompt" }),
      ).toBeChecked()
    })

    await test.step('sets every read tool to Always at once, and shows only those I changed on demand', async () => {
      await approvals.getByRole('tab', { name: 'Read 1' }).click()
      await expect(lookupApproval).toHaveValue('default')
      await approvals.getByRole('button', { name: 'Set all read tools to Always' }).click()
      await expect(lookupApproval).toHaveValue('always')
      await approvals.getByRole('checkbox', { name: 'Only my changes' }).check()
      await expect(approvals.getByRole('list', { name: 'Read tools' }).getByRole('listitem')).toHaveCount(1)
      await approvals.getByRole('tab', { name: 'Write 1' }).click()
      await expect(approvals.getByRole('tabpanel')).toContainText('No tool matches')
    })

    await test.step('sets them back to their default, Never', async () => {
      await approvals.getByRole('tab', { name: 'Read 1' }).click()
      await approvals.getByRole('button', { name: 'Set all read tools to Never' }).click()
      await expect(approvals.getByRole('tabpanel')).toContainText('No tool matches')
      await approvals.getByRole('checkbox', { name: 'Only my changes' }).uncheck()
      await expect(lookupApproval).toHaveValue('default')
    })
  })

  test('As a member, I connect and disconnect a tool, and the chat’s Connected tools panel follows', async ({
    page,
  }) => {
    await openProfile(page, 'Connections')

    await test.step('connects a server of the catalogue', async () => {
      await inPopup(page, () =>
        toolRowOf(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true }).click(),
      )
      await expect(toolRowOf(page, 'Linear')).toContainText('Connected')
      await expect(toolRowOf(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true })).toHaveCount(
        0,
      )
    })

    await test.step('shows it in the chat’s Connected tools panel', async () => {
      await openPanelTab(page, 'Invoice bug', 'Connected tools')
      await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'Linear' })).toHaveText('LinearConnected')
    })

    await test.step('disconnects it and offers to connect it again', async () => {
      await openProfile(page, 'Connections')
      await chooseConnectionAction(page, 'Linear', 'Disconnect')
      await expect(toolRowOf(page, 'Linear')).toContainText('Not connected')
      await expect(toolRowOf(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible()
    })

    await test.step('reflects the disconnection in the panel', async () => {
      await openPanelTab(page, 'Invoice bug', 'Connected tools')
      await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'Linear' })).toHaveText(
        'LinearNot connected',
      )
    })
  })

  test('As a member whose access was revoked at the provider, I see Reconnect when I open my profile, before any chat call', {
    tag: ['@spec-14'],
  }, async ({ page }) => {
    const account = accountOf('alice-acme')
    await connectFake(page, account)
    await fetch(`${fakeMcpUrl}/_admin/expire?user=${account}`, { method: 'POST' })
    await openMyConnections(page)
    await expect(fakeRowOf(page)).toContainText('Needs reconnection')
    await expect(connectionsOf(page).getByRole('button', { name: 'Reconnect fake' })).toBeVisible()
  })

  test('As a member, I connect a tool from the chat when the agent needs it, and my next prompt uses it', {
    tag: ['@spec-14', '@smoke'],
  }, async ({ page, agentScript }) => {
    const account = accountOf('alice-acme')
    await logInAtFakeProvider(page.context(), account)
    await promptTool(page, agentScript, 'Who am I before connecting?')
    const connectButton = messageItemsOf(page).getByRole('button', { name: 'Connect fake', exact: true })
    await expect(connectButton).toBeVisible()
    await expect(mainOf(page)).not.toContainText('gateway-oauth')

    await inPopup(page, () => connectButton.click())
    await promptTool(page, agentScript, 'Who am I now?')
    await expect(toolStepsOf(page)).toHaveCount(2)
    await expect(await lastToolResultOf(page)).toContainText(`you are ${account}`)
  })

  test('As a member of two workspaces, I connect a different account in each and each workspace’s tool calls use its own', {
    tag: ['@spec-14'],
  }, async ({ page, workerStack, agentScript }) => {
    const acmeAccount = accountOf('alice-acme')
    const globexAccount = accountOf('alice-globex')
    await connectFake(page, acmeAccount)
    await page.goto('/w/workspace-globex')
    await addLlmKey(page, 'Mistral')
    await connectFake(page, globexAccount, 'workspace-globex')

    await page.goto('/w/workspace-acme')
    await promptTool(page, agentScript, 'Who am I in Acme?')
    await expect(await lastToolResultOf(page)).toContainText(`you are ${acmeAccount}`)
    expect(await whoamiThroughGateway(workerStack, 'workspace-acme')).toContain(`you are ${acmeAccount}`)
    expect(await whoamiThroughGateway(workerStack, 'workspace-globex')).toContain(`you are ${globexAccount}`)
  })

  test('As a member, I disconnect a tool and get the Connect notice back, and an expired session shows Reconnect in the chat and my profile', {
    tag: ['@spec-14'],
  }, async ({ page, agentScript }) => {
    const account = accountOf('alice-acme')
    await connectFake(page, account)
    await chooseConnectionAction(page, 'fake', 'Disconnect')
    await expect(fakeRowOf(page)).toContainText('Not connected')
    await expect(
      connectionsOf(page)
        .getByRole('status')
        .filter({ hasText: 'remove it in your fake settings to revoke it there too' }),
    ).toBeVisible()
    await expect(connectionsOf(page).getByRole('button', { name: 'Connect fake', exact: true })).toBeVisible()
    await promptTool(page, agentScript, 'Who am I after disconnecting?')
    await expect(messageItemsOf(page).getByRole('button', { name: 'Connect fake', exact: true })).toBeVisible()

    await connectFake(page, account)
    await fetch(`${fakeMcpUrl}/_admin/expire?user=${account}`, { method: 'POST' })
    await promptTool(page, agentScript, 'Who am I after expiry?')
    await expect(messageItemsOf(page).getByRole('button', { name: 'Reconnect fake' })).toBeVisible()
    await openMyConnections(page)
    await expect(fakeRowOf(page)).toContainText('Needs reconnection')
    await inPopup(page, () => connectionsOf(page).getByRole('button', { name: 'Reconnect fake' }).click())
    await expect(fakeRowOf(page)).not.toContainText('Needs reconnection')
    await expect(fakeRowOf(page)).toContainText('Connected')
  })
})
