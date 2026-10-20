import type { WorkerStack } from '../stack'
import { fakeMcpUrl, gatewayUrl } from '../stack-ports'
import {
  accountOf,
  addLlmKey,
  connectedRowOf,
  connectFake,
  connectionsOf,
  expect,
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
      params: { name: 'fake-whoami', arguments: {} },
    }),
  })
  return JSON.stringify(await response.json())
}

const sectionOf = (page: Page, sectionName: string) => mainOf(page).getByRole('region', { name: sectionName })
const connectionsTabOf = (page: Page, tabName: 'Shared with me' | 'My connections') =>
  sectionOf(page, 'Connections').getByRole('tab', { name: tabName })
const connectionsPanelOf = (page: Page) => sectionOf(page, 'Connections').getByRole('tabpanel')
const openMyConnectionsTab = async (page: Page) => {
  await connectionsTabOf(page, 'My connections').click()
  await expect(connectionsTabOf(page, 'My connections')).toHaveAttribute('aria-selected', 'true')
}

test.describe('Personal tools', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see the connections shared with me read-only, and mine with their status and matching actions', async ({
    page,
  }) => {
    await openProfile(page)

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
      await openMyConnectionsTab(page)
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
  })

  test('As a member, I reconnect, connect and disconnect my tools, and the chat’s Connected tools panel follows', async ({
    page,
  }) => {
    await openProfile(page)
    await openMyConnectionsTab(page)

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
    await connectionsOf(page).getByRole('button', { name: 'Disconnect fake' }).click()
    await expect(connectedRowOf(page)).toHaveCount(0)
    await expect(connectionsOf(page).getByRole('group', { name: 'fake' })).toContainText('Not connected')
    await expect(connectionsOf(page).getByRole('button', { name: 'Connect fake', exact: true })).toBeVisible()
    await promptTool(page, agentScript, 'Who am I after disconnecting?')
    await expect(messageItemsOf(page).getByRole('button', { name: 'Connect fake', exact: true })).toBeVisible()

    await connectFake(page, account)
    await fetch(`${fakeMcpUrl}/_admin/expire?user=${account}`, { method: 'POST' })
    await promptTool(page, agentScript, 'Who am I after expiry?')
    await expect(messageItemsOf(page).getByRole('button', { name: 'Reconnect fake' })).toBeVisible()
    await openMyConnections(page)
    await expect(connectedRowOf(page)).toContainText('Needs reconnection')
    await inPopup(page, () => connectionsOf(page).getByRole('button', { name: 'Reconnect fake' }).click())
    await expect(connectedRowOf(page)).not.toContainText('Needs reconnection')
    await expect(connectedRowOf(page)).toContainText('Connected')
  })
})
