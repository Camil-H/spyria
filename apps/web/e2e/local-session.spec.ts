import {
  test as base,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  type Page,
  runsOnChoiceOf,
  sendMessage,
  serverUrl,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

type MachineConversation = {
  agent: {
    acp_command: string[]
    mcp_config: Record<string, { url: string }>
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

const localOption = 'My machine · Claude Code'
const subscriptionCommand = [
  'env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
  'CLAUDE_CODE_MAX_RETRIES=0',
  'claude-agent-acp',
]
const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }
const codexOption = 'My machine · Codex'
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

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', {
    name: /^Model chosen at first prompt$|^Claude Code · |^Codex · |· (auto|same as main)$/,
  })
const newLocalSession = async (page: Page, name: string, option = localOption) => {
  const chatId = await newRuntimeChat(page, name, option)
  await expect(chipOf(page)).toHaveText(`${option.replace('My machine · ', '')} · subscription`)
  return chatId
}
const sessionStarted = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(
      async () =>
        (await workerStack.database.$client`select agent_conversation_id from runtimes where chat_id = ${chatId}`)[0]
          ?.agent_conversation_id,
    )
    .toBeTruthy()
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('3. the owner prompts an On my machine session: it runs on their machine with the subscription config, unmetered', async ({
  page,
  workerStack,
  machine,
}) => {
  const { id: machineId } = await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'On my laptop')
  await sendMessage(page, 'Hello from my laptop')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()

  const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
  expect(runtime?.host_id).toBe(machineId)
  const { conversations } = await machine()
  expect(conversations).toHaveLength(1)
  const [conversation] = conversations
  expect(conversation?.agent).toMatchObject({ acp_command: subscriptionCommand })
  expect(JSON.stringify(conversation)).not.toContain('ANTHROPIC_BASE_URL')
  expect(JSON.stringify(conversation)).not.toContain('ANTHROPIC_MODEL')
  expect(conversation?.secrets).toEqual({})
  expect(Object.keys(conversation?.agent.mcp_config ?? {})).toEqual(['hq'])
  expect(conversation?.agent.mcp_config.hq?.url).toMatch(/\/mcp$/)

  await expect(mainOf(page).getByRole('button', { name: /^Claude Code · / })).toHaveText('Claude Code · subscription')
  const sidePanel = page.getByRole('region', { name: 'Side panel' })
  await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
  await expect(sidePanel).toContainText('Subscription session on your machine, not metered by HQ')
})

test('4. a prompt while the machine is not signed in shows the sign-in notice and creates no conversation', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await newLocalSession(page, 'Not signed in')
  await machine({ signedIn: '' })
  await sendMessage(page, 'Answer without a sign-in')
  await expect(
    repliesWith(page, 'Sign in to Claude Code on your machine: docker exec -it hq-host hq-host login claude'),
  ).toHaveCount(1)
  const { conversations, prompts } = await machine()
  expect(conversations).toHaveLength(0)
  expect(prompts).toHaveLength(0)
})

test('5. another member reads the session and the answer, and their prompt is refused without an agent call', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  await newLocalSession(page, 'Shared laptop session')
  await sendMessage(page, 'Alice prompts the laptop')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Shared laptop session')
  await expect(repliesWith(bobPage, 'Hello from the stub')).toBeVisible()
  await sendMessage(bobPage, 'Bob tries the laptop')
  await expect(repliesWith(bobPage, 'Only the owner prompts a session on their machine')).toHaveCount(1)
  await expect(repliesWith(page, 'Only the owner prompts a session on their machine')).toHaveCount(1)
  expect((await machine()).prompts).toEqual(['Alice prompts the laptop'])
  await bobPage.context().close()
})

test('6. a prompt while the machine is offline waits with "Your machine is offline" and is answered once it is back', async ({
  page,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  await sessionStarted(workerStack, await newLocalSession(page, 'Laptop goes away'))
  await machine({ online: 'false' })
  await sendMessage(page, 'Wait for my laptop')
  await expect(repliesWith(page, 'Your machine is offline')).toHaveCount(1)
  await machine({ online: 'true' })
  await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible()

  await machine({ online: 'false' })
  await sendMessage(page, 'Wait for my laptop again')
  await expect(repliesWith(page, 'Your machine is offline')).toHaveCount(2)
  await machine({ online: 'true' })
  await expect(repliesWith(page, '[t2] Hello from the stub')).toBeVisible()
  expect((await machine()).prompts).toEqual(['Wait for my laptop', 'Wait for my laptop again'])
})

test('10. text streamed around a command shows before the command and stays, the rest after it, and nothing is stored twice', async ({
  page,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  const chatId = await newLocalSession(page, 'Live text')
  await sendMessage(page, 'stub:command stub:linger')
  await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toBeVisible()
  await expect(messageItemsOf(page).nth(1)).toContainText('[t1]')
  await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(4)
  await expect(messageItemsOf(page).nth(1)).toContainText('[t1]')
  await expect(messageItemsOf(page).nth(2)).toContainText('$ sleep 2 && echo checked')
  await expect(messageItemsOf(page).nth(3)).toContainText('Hello from the stub')
  await expect(messageItemsOf(page).nth(3)).not.toContainText('[t1]')
  const answers = await workerStack.database.$client<{ body: string }[]>`
    select body from messages where chat_id = ${chatId} and kind = 'agent' order by seq`
  expect(answers.map((answer) => answer.body)).toEqual([
    '[t1]',
    'Hello from the stub (model stub-default, mode bypassPermissions).',
  ])
})

test.describe('Codex on a ChatGPT plan', () => {
  test('1. the owner prompts an On my machine Codex session: the subscription launch, the answer, unmetered', async ({
    page,
    machine,
  }) => {
    await machine(codexMachine)
    await newLocalSession(page, 'Codex on my laptop', codexOption)
    await sendMessage(page, 'Hello Codex on my laptop')
    await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()

    const { conversations } = await machine()
    expect(conversations).toHaveLength(1)
    const [conversation] = conversations
    expect(conversation?.agent).toMatchObject({ acp_command: codexSubscriptionCommand })
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
  })

  test('2. signed in to Claude only, Codex is not offered, a Codex session signed out after the choice shows the Codex sign-in notice, and a Claude Code session works', async ({
    page,
    workerStack,
    machine,
  }) => {
    await machine(signedInMachine)
    const claudeOnlyId = await newRuntimeChat(page, 'Claude only', null)
    await expect(runsOnChoiceOf(page)).toHaveCount(0)
    await expect(chipOf(page)).toHaveText('Claude Code · subscription')
    await expect.poll(async () => (await machine()).conversations.length).toBe(1)
    await sessionStarted(workerStack, claudeOnlyId)
    await machine({ signedIn: 'claude,codex' })
    await sessionStarted(workerStack, await newLocalSession(page, 'Codex without a sign-in', codexOption))
    await expect.poll(async () => (await machine()).conversations.length).toBe(2)
    await machine({ signedIn: 'claude' })
    await sendMessage(page, 'Answer without a Codex sign-in')
    await expect(
      repliesWith(page, 'Sign in to Codex on your machine: docker exec -it hq-host hq-host login codex'),
    ).toHaveCount(1)
    expect((await machine()).conversations).toHaveLength(2)

    await newLocalSession(page, 'Claude on the same laptop')
    await sendMessage(page, 'Hello Claude on the same laptop')
    await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()
    const { conversations, prompts } = await machine()
    expect(conversations.map((conversation) => conversation.agent.acp_command.at(-1))).toEqual([
      'claude-agent-acp',
      expect.stringContaining('exec codex-acp'),
      'claude-agent-acp',
    ])
    expect(prompts).toEqual(['Hello Claude on the same laptop'])
  })

  test('5. a command pending with no input shows the real command and no spinner once completed, and a read shows its path', async ({
    page,
    machine,
  }) => {
    await machine(codexMachine)
    await newLocalSession(page, 'Real steps', codexOption)
    await sendMessage(page, 'stub:read stub:tools stub:linger')
    await expect(repliesWith(page, '$ npm test').getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(repliesWith(page, 'Read notes.md')).toBeVisible()
    await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
    await messageItemsOf(page)
      .getByRole('button', { name: /^Worked for .+ · 3 steps$/ })
      .click()
    await expect(repliesWith(page, 'Read notes.md')).toBeVisible()
    const command = repliesWith(page, '$ npm test')
    await expect(command.getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('$ Terminal')
    await expect(mainOf(page)).not.toContainText('Read File')
  })
})
