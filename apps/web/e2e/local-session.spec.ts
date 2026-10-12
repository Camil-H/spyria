import { test as base, expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, serverUrl } from './fixtures'
import { openPageAs } from './stack'

type MachineConversation = {
  agent: {
    kind: string
    acp_server: string
    acp_command: string[]
    mcp_config: Record<string, { url: string }>
    acp_resume_session_id?: string
  }
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
const codexOption = 'On my machine · Codex (ChatGPT plan)'
const codexSubscriptionCommand = [
  'env',
  `HQ_CODEX_CONFIG=forced_login_method = "chatgpt"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`,
  'sh',
  '-c',
  'set -e; printf %s "$HQ_CODEX_CONFIG" > "$HOME/.codex/config.toml.$$"; mv "$HOME/.codex/config.toml.$$" "$HOME/.codex/config.toml"; exec codex-acp',
]
const codexMachine = { owner: 'member-alice', signedIn: 'codex' }

const openNewChat = async (page: Page) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  return page.getByRole('dialog', { name: 'New chat' })
}
const newLocalSession = async (page: Page, name: string, option = localOption) => {
  const dialog = await openNewChat(page)
  await dialog.getByRole('radio', { name: option }).check()
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

test('10. text streamed around a command shows before the command and stays, the rest after it, and nothing is stored twice', async ({
  page,
  workerStack,
  machine,
  agentScript,
}) => {
  await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'Live text')
  await agentScript(chatId, {
    steps: [{ command: 'sleep 2 && echo checked', say: 'Looking.' }],
    text: 'Done.',
    wordDelayMilliseconds: 300,
  })
  await sendMessage(page, 'Check the repo')
  await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toBeVisible(agentReply)
  await expect(messageItemsOf(page).nth(1)).toContainText('Looking.')
  await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0, agentReply)
  await expect(messageItemsOf(page)).toHaveCount(4)
  await expect(messageItemsOf(page).nth(1)).toContainText('Looking.')
  await expect(messageItemsOf(page).nth(2)).toContainText('$ sleep 2 && echo checked')
  await expect(messageItemsOf(page).nth(3)).toContainText('Done.')
  await expect(messageItemsOf(page).nth(3)).not.toContainText('Looking.')
  const answers = await workerStack.database.$client<{ body: string }[]>`
    select body from messages where chat_id = ${chatId} and kind = 'agent' order by seq`
  expect(answers.map((answer) => answer.body)).toEqual(['Looking.', 'Done.'])
})

test.describe('Codex on a ChatGPT plan', () => {
  test('1. the owner prompts an On my machine Codex session: the subscription launch, the answer, unmetered', async ({
    page,
    workerStack,
    machine,
    agentScript,
  }) => {
    await machine(codexMachine)
    const chatId = await newLocalSession(page, 'Codex on my laptop', codexOption)
    await agentScript(chatId, { text: 'Answered on the ChatGPT plan.' })
    await sendMessage(page, 'Hello Codex on my laptop')
    await expect(repliesWith(page, 'Answered on the ChatGPT plan.')).toBeVisible(agentReply)

    const { conversations } = await machine()
    expect(conversations).toHaveLength(1)
    const [conversation] = conversations
    expect(conversation?.agent).toMatchObject({
      kind: 'ACPAgent',
      acp_server: 'codex',
      acp_command: codexSubscriptionCommand,
    })
    expect(JSON.stringify(conversation)).not.toMatch(
      /OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|"CODEX_CONFIG=|MODEL_PROVIDER|base_url|model_provider|"model"/,
    )
    expect(conversation?.secrets).toEqual({})
    expect(Object.keys(conversation?.agent.mcp_config ?? {})).toEqual(['hq'])
    expect(conversation?.agent.mcp_config.hq?.url).toMatch(/\/mcp$/)

    await expect(mainOf(page).getByRole('button', { name: /^Codex · / })).toHaveText('Codex · subscription')
    const sidePanel = page.getByRole('region', { name: 'Side panel' })
    await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
    await expect(sidePanel).toContainText('Subscription session on your machine, not metered by HQ')
    await page.waitForTimeout(3_000)
    const query = `metadata_chat=${chatId}&metadata_database=${workerStack.databaseName}&limit=10`
    expect((await workerStack.gateway<{ logs: object[] | null }>(`/api/logs?${query}`)).logs ?? []).toHaveLength(0)
  })

  test('2. signed in to Claude only, a Codex session shows the Codex sign-in notice and a Claude Code session works', async ({
    page,
    machine,
    agentScript,
  }) => {
    await machine(signedInMachine)
    await newLocalSession(page, 'Codex without a sign-in', codexOption)
    await sendMessage(page, 'Answer without a Codex sign-in')
    await expect(
      repliesWith(page, 'Sign in to Codex on your machine: docker exec -it hq-host hq-host login codex'),
    ).toHaveCount(1, agentReply)
    expect((await machine()).conversations).toHaveLength(0)

    const claudeChatId = await newLocalSession(page, 'Claude on the same laptop')
    await agentScript(claudeChatId, { text: 'Claude answered on the same machine.' })
    await sendMessage(page, 'Hello Claude on the same laptop')
    await expect(repliesWith(page, 'Claude answered on the same machine.')).toBeVisible(agentReply)
    const { conversations, prompts } = await machine()
    expect(conversations.map((conversation) => conversation.agent.acp_server)).toEqual(['claude-code'])
    expect(prompts).toEqual(['Hello Claude on the same laptop'])
  })

  test('3. stopping mid-command deletes the conversation before the turn shows stopped, and the next prompt resumes the Codex session once', async ({
    page,
    workerStack,
    machine,
    agentScript,
  }) => {
    await machine(codexMachine)
    const chatId = await newLocalSession(page, 'Stop Codex on my laptop', codexOption)
    await agentScript(chatId, { steps: [{ command: 'sleep 30' }], text: 'Never shown.' })
    await sendMessage(page, 'Run the long command')
    await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toBeVisible(agentReply)
    await mainOf(page).getByRole('button', { name: 'Stop' }).click()
    await expect(repliesWith(page, 'Stopped by Alice')).toHaveCount(1, agentReply)
    expect((await machine()).conversations).toHaveLength(0)
    const sessionIds = await workerStack.database.$client<{ id: string }[]>`
      select distinct payload->'event'->'value'->>'acp_session_id' as id from events
      where chat_id = ${chatId} and payload->'event'->>'key' = 'agent_state'`
    expect(sessionIds).toHaveLength(1)

    await agentScript(chatId, { text: 'Back after the stop.' })
    await sendMessage(page, 'Answer after the stop')
    await expect(repliesWith(page, 'Back after the stop.')).toHaveCount(1, agentReply)
    await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0, agentReply)
    await expect(mainOf(page)).not.toContainText('Never shown.')
    await expect(mainOf(page)).not.toContainText('The agent started a new session')
    const { conversations, prompts } = await machine()
    expect(prompts).toEqual(['Run the long command', 'Answer after the stop'])
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.agent.acp_command).toEqual(codexSubscriptionCommand)
    expect(conversations[0]?.agent.acp_resume_session_id).toBe(sessionIds[0]?.id)
  })

  test('4. the New chat dialog offers both On my machine options only to a member with a local host', async ({
    page,
    machine,
  }) => {
    const dialog = await openNewChat(page)
    await expect(dialog.getByRole('radio', { name: /^On my machine/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await machine({ owner: 'member-alice', signedIn: '' })
    await openNewChat(page)
    await expect(dialog.getByRole('radio', { name: localOption })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: codexOption })).toBeVisible()
  })

  test('5. a command pending with no input shows the real command and no spinner once completed, and a read shows its path', async ({
    page,
    machine,
    agentScript,
  }) => {
    await machine(codexMachine)
    const chatId = await newLocalSession(page, 'Real steps', codexOption)
    await agentScript(chatId, {
      steps: [{ command: 'echo listed' }, { read: 'notes.md' }],
      text: 'Read the notes and listed the files.',
      wordDelayMilliseconds: 400,
    })
    await sendMessage(page, 'List and read')
    const command = repliesWith(page, '$ echo listed')
    await expect(command.getByRole('img', { name: 'Succeeded' })).toBeVisible(agentReply)
    await expect(repliesWith(page, 'Read notes.md')).toBeVisible(agentReply)
    await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
    await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('$ Terminal')
    await expect(mainOf(page)).not.toContainText('Read File')
  })
})
