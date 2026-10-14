import type { BrowserContext } from '@playwright/test'
import { expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, test } from './fixtures'
import { openPageAs, type WorkerStack } from './stack'
import { fakeMcpUrl, gatewayUrl } from './stack-ports'

const research = 'chat-research'
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
const workingIndicatorOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
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
const fakeProviderCalls = async () =>
  (await (await fetch(`${fakeMcpUrl}/_records`)).json()) as { tool: string; user: string }[]
const addLlmKey = async (page: Page, workspace = 'workspace-acme') => {
  await page.goto(`/w/${workspace}/profile`)
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  const secret = `fake-key-${crypto.randomUUID()}`
  await llmSection.getByLabel('Provider').fill('Fake')
  await llmSection.getByLabel('Secret').fill(secret)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: `••••${secret.slice(-4)}` })).toBeVisible()
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

test('1. the profile lists the fake server as not connected; Connect runs the consent popup and shows it connected', async ({
  page,
}) => {
  await logInAtFakeProvider(page.context(), accountOf('alice-acme'))
  await openMyConnections(page)
  await expect(connectionsOf(page).getByRole('group', { name: 'fake' })).toContainText('Not connected')
  await expect(connectedRowOf(page)).toHaveCount(0)

  await inPopup(page, () => connectionsOf(page).getByRole('button', { name: 'Connect fake', exact: true }).click())
  await expect(connectedRowOf(page)).toContainText('Connected')
  await expect(connectionsOf(page).getByRole('button', { name: 'Disconnect fake' })).toBeVisible()
  await expect(connectionsOf(page).getByRole('group', { name: 'fake' })).toHaveCount(0)
})

test('2. the agent uses the tool as the owner: "Used whoami (fake)" with the result, and the provider saw Alice’s Acme account', async ({
  page,
  agentScript,
}) => {
  const account = accountOf('alice-acme')
  await connectFake(page, account)
  await promptTool(page, agentScript, 'Who am I on fake?')

  await expect(toolStepsOf(page)).toHaveCount(1)
  await expect(await lastToolResultOf(page)).toContainText(`you are ${account}`)
  await expect(messageItemsOf(page).filter({ hasText: 'Checked who I am.' })).toHaveCount(1)
  expect(await fakeProviderCalls()).toContainEqual({ tool: 'whoami', user: account })
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
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage)
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
  await addLlmKey(page, 'workspace-globex')
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

test.describe('real Agent Server', { tag: '@docker' }, () => {
  test.use({ agentServer: 'real' })

  test('7. the real Agent Server calls the fake tool through the relay as the owner', async ({ page, agentScript }) => {
    const account = accountOf('alice-acme')
    await connectFake(page, account)
    await promptTool(page, agentScript, 'Who am I, real agent?')
    await expect(toolStepsOf(page)).toHaveCount(1)
    await expect(await lastToolResultOf(page)).toContainText(`you are ${account}`)
    expect(await fakeProviderCalls()).toContainEqual({ tool: 'whoami', user: account })
  })
})
