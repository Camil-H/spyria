import { test as base, expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, serverUrl } from './fixtures'
import { openPageAs } from './stack'

type MachineConversation = {
  agent: { kind: string; acp_server: string; acp_command: string[]; mcp_config: Record<string, { url: string }> }
  secrets: Record<string, unknown>
}
type Machine = { id: string; conversations: MachineConversation[]; prompts: string[] }
type MachineQuery = { owner?: string; signedIn?: string; online?: string }

const test = base.extend<{ machine: (query?: MachineQuery) => Promise<Machine> }>({
  machine: async ({ workerStack }, use) => {
    const machine = async (query: MachineQuery = {}) => {
      const search = new URLSearchParams({ db: workerStack.databaseName, ...query })
      return (await (await fetch(`${serverUrl}/test/fake-machine?${search}`, { method: 'POST' })).json()) as Machine
    }
    await use(machine)
    await machine({ online: 'false' })
  },
})

const agentReply = { timeout: 30_000 }
const localOption = 'On my machine · Claude Code subscription'
const subscriptionCommand = [
  'env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
  'CLAUDE_CODE_MAX_RETRIES=0',
  'claude-agent-acp',
]
const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }

const openNewChat = async (page: Page) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  return page.getByRole('dialog', { name: 'New chat' })
}
const newLocalSession = async (page: Page, name: string) => {
  const dialog = await openNewChat(page)
  await dialog.getByRole('radio', { name: localOption }).check()
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  return page.url().split('/').at(-1) ?? ''
}
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('3. the owner prompts an On my machine session: it runs on their machine with the subscription config, unmetered', async ({
  page,
  workerStack,
  machine,
  agentScript,
}) => {
  const { id: machineId } = await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'On my laptop')
  await agentScript(chatId, { text: 'Answered on the subscription.' })
  await sendMessage(page, 'Hello from my laptop')
  await expect(repliesWith(page, 'Answered on the subscription.')).toBeVisible(agentReply)

  const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
  expect(runtime?.host_id).toBe(machineId)
  const { conversations } = await machine()
  expect(conversations).toHaveLength(1)
  const [conversation] = conversations
  expect(conversation?.agent).toMatchObject({
    kind: 'ACPAgent',
    acp_server: 'claude-code',
    acp_command: subscriptionCommand,
  })
  expect(JSON.stringify(conversation)).not.toContain('ANTHROPIC_BASE_URL')
  expect(JSON.stringify(conversation)).not.toContain('ANTHROPIC_MODEL')
  expect(conversation?.secrets).toEqual({})
  expect(Object.keys(conversation?.agent.mcp_config ?? {})).toEqual(['hq'])
  expect(conversation?.agent.mcp_config.hq?.url).toMatch(/\/mcp$/)

  await expect(mainOf(page).getByRole('button', { name: /^Claude Code · / })).toHaveText('Claude Code · subscription')
  const sidePanel = page.getByRole('region', { name: 'Side panel' })
  await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
  await expect(sidePanel).toContainText('Subscription session on your machine, not metered by HQ')
  await page.waitForTimeout(3_000)
  const query = `metadata_chat=${chatId}&metadata_database=${workerStack.databaseName}&limit=10`
  expect((await workerStack.gateway<{ logs: object[] | null }>(`/api/logs?${query}`)).logs ?? []).toHaveLength(0)
})

test('4. a prompt while the machine is not signed in shows the sign-in notice and creates no conversation', async ({
  page,
  machine,
}) => {
  await machine({ owner: 'member-alice', signedIn: '' })
  await newLocalSession(page, 'Not signed in')
  await sendMessage(page, 'Answer without a sign-in')
  await expect(
    repliesWith(page, 'Sign in to Claude Code on your machine: docker exec -it hq-host hq-host login claude'),
  ).toHaveCount(1, agentReply)
  const { conversations, prompts } = await machine()
  expect(conversations).toHaveLength(0)
  expect(prompts).toHaveLength(0)
})

test('5. another member reads the session and the answer, and their prompt is refused without an agent call', async ({
  page,
  browser,
  workerStack,
  machine,
  agentScript,
}) => {
  await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'Shared laptop session')
  await agentScript(chatId, { text: 'Alice got this answer.' })
  await sendMessage(page, 'Alice prompts the laptop')
  await expect(repliesWith(page, 'Alice got this answer.')).toBeVisible(agentReply)

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Shared laptop session')
  await expect(repliesWith(bobPage, 'Alice got this answer.')).toBeVisible()
  await sendMessage(bobPage, 'Bob tries the laptop')
  await expect(repliesWith(bobPage, 'Only the owner prompts a session on their machine')).toHaveCount(1, agentReply)
  await expect(repliesWith(page, 'Only the owner prompts a session on their machine')).toHaveCount(1)
  expect((await machine()).prompts).toEqual(['Alice prompts the laptop'])
  await bobPage.context().close()
})

test('6. a prompt while the machine is offline waits with "Your machine is offline" and is answered once it is back', async ({
  page,
  machine,
  agentScript,
}) => {
  await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'Laptop goes away')
  await machine({ online: 'false' })
  await agentScript(chatId, { text: 'Answered once the laptop is back.' })
  await sendMessage(page, 'Wait for my laptop')
  await expect(repliesWith(page, 'Your machine is offline')).toHaveCount(1, agentReply)
  await machine({ online: 'true' })
  await expect(repliesWith(page, 'Answered once the laptop is back.')).toBeVisible(agentReply)

  await machine({ online: 'false' })
  await agentScript(chatId, { text: 'Answered after the second outage.' })
  await sendMessage(page, 'Wait for my laptop again')
  await expect(repliesWith(page, 'Your machine is offline')).toHaveCount(2, agentReply)
  await machine({ online: 'true' })
  await expect(repliesWith(page, 'Answered after the second outage.')).toBeVisible(agentReply)
  expect((await machine()).prompts).toEqual(['Wait for my laptop', 'Wait for my laptop again'])
})

test('8. stopping mid-command marks the turn stopped, and the next prompt is answered once in a new subscription conversation', async ({
  page,
  machine,
  agentScript,
}) => {
  await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'Stop on my laptop')
  await agentScript(chatId, { steps: [{ command: 'sleep 30' }], text: 'Never shown.' })
  await sendMessage(page, 'Run the long command')
  await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toBeVisible(agentReply)
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(repliesWith(page, 'Stopped by Alice')).toHaveCount(1, agentReply)
  await agentScript(chatId, { text: 'Back after the stop.' })
  await sendMessage(page, 'Answer after the stop')
  await expect(repliesWith(page, 'Back after the stop.')).toHaveCount(1, agentReply)
  await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0, agentReply)
  await expect(mainOf(page)).not.toContainText('Never shown.')
  const { conversations, prompts } = await machine()
  expect(prompts).toEqual(['Run the long command', 'Answer after the stop'])
  expect(conversations.map((conversation) => conversation.agent.acp_command)).toEqual([subscriptionCommand])
})

test('9. the New chat dialog offers On my machine only to a member with a local host', async ({ page, machine }) => {
  const dialog = await openNewChat(page)
  await expect(dialog.getByRole('radio')).toHaveCount(2)
  await expect(dialog.getByRole('radio', { name: localOption })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await machine(signedInMachine)
  await openNewChat(page)
  await expect(dialog.getByRole('radio', { name: localOption })).toBeVisible()
})
