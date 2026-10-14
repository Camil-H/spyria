import {
  agentReplyText,
  expect,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  openChat,
  openProfile,
  type Page,
  sendButtonOf,
  sendMessage,
  serverUrl,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const blockedNotice = 'Connect an LLM key in your profile to prompt'
const research = 'chat-research'
type GatewayLog = { virtual_key_id: string | null; selected_key_id: string; metadata: Record<string, string> | null }

const addKey = async (page: Page, provider: string, secret: string) => {
  await openProfile(page)
  await llmSectionOf(page).getByLabel('Provider').fill(provider)
  await llmSectionOf(page).getByLabel('Secret').fill(secret)
  await llmSectionOf(page).getByRole('button', { name: 'Add' }).click()
  await expect(
    llmSectionOf(page)
      .getByRole('listitem')
      .filter({ hasText: `••••${secret.slice(-4)}` }),
  ).toBeVisible()
}
const removeKey = async (page: Page, provider: string) => {
  await openProfile(page)
  await llmSectionOf(page)
    .getByRole('button', { name: `Remove ${provider}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove LLM key' }).getByRole('button', { name: 'Remove' }).click()
  await expect(llmSectionOf(page).getByRole('button', { name: `Remove ${provider}` })).toHaveCount(0)
}
const newSecret = (prefix = 'fake-key') => `${prefix}-${crypto.randomUUID()}`
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const virtualKeyOf = async (workerStack: WorkerStack, memberId: string) =>
  (await workerStack.database.$client`select virtual_key_id from member_gateway_keys where user_id = ${memberId}`)[0]
    ?.virtual_key_id as string | undefined
const gatewayKeyIdsOf = async (workerStack: WorkerStack, memberId: string) =>
  (await workerStack.database.$client`select secret_ref from llm_credentials where user_id = ${memberId}`).map((row) =>
    String(row.secret_ref).split('/').at(-1),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. an added key is stored in the gateway: HQ keeps only its last 4 characters and a reference', async ({
  page,
  workerStack,
}) => {
  const secret = newSecret()
  await addKey(page, 'Fake', secret)

  const tables = await workerStack.database.$client<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  for (const { name } of tables) {
    const rows = await workerStack.database.$client.unsafe(`select * from "${name}"`)
    expect({ name, leaks: JSON.stringify(rows).includes(secret) }).toEqual({ name, leaks: false })
  }
  const [added] = await workerStack.database.$client`
    select secret_ref from llm_credentials where user_id = 'member-alice' and provider = 'Fake'`
  const keyId = String(added?.secret_ref).split('/').at(-1)
  const { keys } = await workerStack.gateway<{ keys: { id: string }[] }>('/api/providers/fake/keys')
  expect(keys.map((key) => key.id)).toContain(keyId)
  const { virtual_key } = await workerStack.gateway<{
    virtual_key: { provider_configs: { keys: { key_id: string }[] }[] }
  }>(`/api/governance/virtual-keys/${await virtualKeyOf(workerStack, 'member-alice')}`)
  expect(virtual_key.provider_configs.flatMap((config) => config.keys.map((key) => key.key_id))).toContain(keyId)
})

test.describe('real Agent Server', { tag: '@docker' }, () => {
  test.use({ agentServer: 'real' })

  test('2. two members prompt the same chat and each turn runs on the prompter’s own key', async ({
    page,
    browser,
    workerStack,
  }) => {
    const startedAt = new Date()
    await addKey(page, 'Fake', newSecret())
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addKey(bobPage, 'Fake', newSecret())

    await openChat(page, 'Research')
    await sendMessage(page, 'Alice asks')
    await expect(repliesWith(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await openChat(bobPage, 'Research')
    await sendMessage(bobPage, 'Bob asks')
    await expect(repliesWith(bobPage, agentReplyText)).toHaveCount(2)

    for (const prompter of ['member-alice', 'member-bob']) {
      const virtualKeyId = await virtualKeyOf(workerStack, prompter)
      const ownKeyIds = await gatewayKeyIdsOf(workerStack, prompter)
      const callsOf = async () =>
        (
          await workerStack.gateway<{ logs: GatewayLog[] }>(
            `/api/logs?virtual_key_ids=${virtualKeyId}&start_time=${startedAt.toISOString()}&limit=100`,
          )
        ).logs
      await expect.poll(async () => (await callsOf()).length).toBeGreaterThan(0)
      for (const call of await callsOf()) {
        expect(ownKeyIds).toContain(call.selected_key_id)
        expect(call.metadata).toMatchObject({ prompter, owner: 'member-alice', chat: research })
      }
    }
    await bobPage.context().close()
  })
})

test('3. a member without a key cannot prompt, and a crafted mutation is refused by the server', async ({
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Research')
  await expect(mainOf(bobPage)).toContainText(blockedNotice)
  await expect(sendButtonOf(bobPage)).toBeDisabled()

  const session = await (
    await fetch(`${serverUrl}/test/token?db=${workerStack.databaseName}&user=member-bob&workspace=workspace-acme`, {
      method: 'POST',
    })
  ).json()
  const appId = `hqe2e${test.info().parallelIndex}`
  const response = await fetch(`${serverUrl}/api/mutate?schema=${appId}_0&appID=${appId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [
        {
          type: 'custom',
          id: 1,
          clientID: crypto.randomUUID(),
          name: 'conversation.sendMessage',
          args: [{ workspaceId: 'workspace-acme', id: crypto.randomUUID(), chatId: research, text: 'Crafted prompt' }],
          timestamp: Date.now(),
        },
      ],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  expect(JSON.stringify(await response.json())).toContain('Bob has no LLM key in this workspace')
  expect(await workerStack.database.$client`select 1 from messages where body = 'Crafted prompt'`).toHaveLength(0)
  await bobPage.context().close()
})

test('4. a member who removes their key can no longer prompt, while another member still can', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addKey(bobPage, 'Fake', newSecret())
  await openChat(page, 'Research')
  await sendMessage(page, 'Before removing my key')
  await expect(repliesWith(page, agentReplyText)).toHaveCount(1)

  await removeKey(page, 'Anthropic')
  await openChat(page, 'Research')
  await expect(mainOf(page)).toContainText(blockedNotice)
  await expect(sendButtonOf(page)).toBeDisabled()

  await openChat(bobPage, 'Research')
  await sendMessage(bobPage, 'Bob still prompts')
  await expect(repliesWith(bobPage, agentReplyText)).toHaveCount(2)
  await bobPage.context().close()
})

test('5. a key the provider refuses ends the turn with HQ’s notice and no provider text', async ({ page }) => {
  await removeKey(page, 'Anthropic')
  await addKey(page, 'Fake', newSecret('fake-refused'))
  await openChat(page, 'Research')
  await sendMessage(page, 'Use my refused key')

  const error = messageItemsOf(page).getByRole('alert')
  await expect(error).toContainText('The LLM key of Alice was refused')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(mainOf(page)).not.toContainText('Incorrect API key')
  await expect(mainOf(page)).not.toContainText('fake-refused')
})

test('6. with the gateway down a prompt gets HQ’s notice; once it is back the next prompt is answered', async ({
  page,
  workerStack,
}) => {
  await openChat(page, 'Research')
  await workerStack.setGatewayReachable(false)
  await sendMessage(page, 'While the gateway is down')
  await expect(messageItemsOf(page).getByRole('alert')).toContainText('The model gateway is unreachable')
  await expect(workingIndicatorOf(page)).toHaveCount(0)

  await workerStack.setGatewayReachable(true)
  await sendMessage(page, 'Now that it is back')
  await expect(repliesWith(page, agentReplyText)).toHaveCount(1)
})
