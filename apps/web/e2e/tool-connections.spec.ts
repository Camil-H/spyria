import type { BrowserContext } from '@playwright/test'
import {
  addLlmKey,
  addParticipant,
  expect,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'
import { fakeMcpUrl, gatewayUrl } from './stack-ports'

const toolStep = 'Used whoami (fake)'
const toolScript = { steps: [{ tool: 'fake-whoami' }], text: 'Checked who I am.' }

const accountOf = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}`
const logInAtFakeProvider = (context: BrowserContext, account: string) =>
  context.addCookies([{ name: 'fake_mcp_user', value: account, url: fakeMcpUrl }])
const connectionsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Connections' })
const openMyConnections = async (page: Page, workspace = 'workspace-acme') => {
  await page.goto(`/w/${workspace}/profile`)
  await connectionsOf(page).getByRole('tab', { name: 'My connections' }).click()
}
const connectedRowOf = (page: Page) => connectionsOf(page).getByRole('listitem').filter({ hasText: 'fake' })
const inPopup = async (page: Page, open: () => Promise<void>) => {
  const popup = page.waitForEvent('popup')
  await open()
  await (await popup).waitForEvent('close')
}
const connectFake = async (page: Page, account: string, workspace = 'workspace-acme') => {
  await logInAtFakeProvider(page.context(), account)
  await openMyConnections(page, workspace)
  await inPopup(page, () => connectionsOf(page).getByRole('button', { name: 'Connect fake', exact: true }).click())
  await expect(connectedRowOf(page)).toContainText('Connected')
}
const promptTool = async (page: Page, agentScript: (chat: string, script: object) => Promise<void>, text: string) => {
  await agentScript(research, toolScript)
  await openChat(page, 'Research')
  await sendMessage(page, text)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
const toolStepsOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: toolStep })
const lastToolResultOf = async (page: Page) => {
  await toolStepsOf(page).last().click()
  return messageItemsOf(page)
    .filter({ has: page.getByRole('button', { name: toolStep, expanded: true }) })
    .last()
}
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

test('3. a call before connecting shows Connect fake; after connecting in the popup the next prompt uses the tool', async ({
  page,
  agentScript,
}) => {
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

test('4. another prompter triggers the tool as the owner and sees that the owner must connect, without a button', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  await addParticipant(workerStack, research, 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await promptTool(bobPage, agentScript, 'Bob asks who the agent is')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'Alice needs to connect fake' })).toHaveCount(1)
  await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Connect fake' })).toHaveCount(0)

  const account = accountOf('alice-acme')
  await connectFake(page, account)
  await promptTool(bobPage, agentScript, 'Bob asks again')
  await expect(await lastToolResultOf(bobPage)).toContainText(`you are ${account}`)
  await bobPage.context().close()
})

test('5. Alice connects a different account per workspace and each workspace’s tool calls use its own account', async ({
  page,
  workerStack,
  agentScript,
}) => {
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

test('6. disconnecting brings back the Connect notice; an expired session shows Reconnect in the chat and the profile', async ({
  page,
  agentScript,
}) => {
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
