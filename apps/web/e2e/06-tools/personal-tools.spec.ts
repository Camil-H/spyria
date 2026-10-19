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
  promptTool,
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

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('a tool call before connecting shows Connect fake; after connecting in the popup the next prompt uses the tool', {
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

test('Alice connects a different account per workspace and each workspace’s tool calls use its own account', {
  tag: ['@spec-14'],
}, async ({ page, workerStack, agentScript }) => {
  const acmeAccount = accountOf('alice-acme')
  const globexAccount = accountOf('alice-globex')
  await connectFake(page, acmeAccount)
  await page.goto('/w/workspace-globex')
  await addLlmKey(page, 'Fake')
  await connectFake(page, globexAccount, 'workspace-globex')

  await page.goto('/w/workspace-acme')
  await promptTool(page, agentScript, 'Who am I in Acme?')
  await expect(await lastToolResultOf(page)).toContainText(`you are ${acmeAccount}`)
  expect(await whoamiThroughGateway(workerStack, 'workspace-acme')).toContain(`you are ${acmeAccount}`)
  expect(await whoamiThroughGateway(workerStack, 'workspace-globex')).toContain(`you are ${globexAccount}`)
})

test('disconnecting brings back the Connect notice; an expired session shows Reconnect in the chat and the profile', {
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
