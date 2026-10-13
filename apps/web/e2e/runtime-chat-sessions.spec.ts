import {
  test as base,
  chooseRunsOn,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  type Page,
  runsOnChoiceOf,
  sendButtonOf,
  sendMessage,
  serverUrl,
  sidebarOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

type MachineConversation = {
  agent: { acp_command: string[]; acp_model?: string }
  secrets: Record<string, unknown>
}
type Machine = { id: string; conversations: MachineConversation[]; prompts: string[]; modelSwitches: string[] }
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
const claudeOnMachine = 'My machine · Claude Code'
const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }
const subscriptionCommand = [
  'env',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
  'CLAUDE_CODE_MAX_RETRIES=0',
  'claude-agent-acp',
]

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', {
    name: /^Model chosen at first prompt$|^Claude Code · |^Codex · |· (auto|same as main)$/,
  })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const runsOnOf = (page: Page) => sessionOf(page).getByRole('combobox', { name: 'Runs on' })
const expectRunsOnChoices = async (page: Page, names: string[]) => {
  await expect(runsOnChoiceOf(page).getByRole('radio')).toHaveCount(names.length)
  for (const name of names) await expect(runsOnChoiceOf(page).getByRole('radio', { name })).not.toBeChecked()
}
const expectRunsOnChosen = async (page: Page, name: string) => {
  await expect(runsOnChoiceOf(page)).toHaveCount(0)
  await openSession(page)
  await expect(sessionOf(page).getByText(`Runs on ${name}`)).toBeVisible()
}
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const openSession = async (page: Page) => {
  if (!(await sessionOf(page).isVisible())) await chipOf(page).click()
  await expect(sessionOf(page)).toBeVisible()
}
const newMachineChat = async (page: Page, name: string) => {
  const chatId = await newRuntimeChat(page, name, claudeOnMachine)
  await expect(chipOf(page)).toHaveText('Claude Code · subscription')
  return chatId
}
const tokenOf = async (workerStack: WorkerStack, user: string) =>
  (
    await (
      await fetch(`${serverUrl}/test/token?db=${workerStack.databaseName}&user=${user}&workspace=workspace-acme`, {
        method: 'POST',
      })
    ).json()
  ).token as string
const craftedMutation = async (workerStack: WorkerStack, user: string, name: string, args: object) => {
  const appId = `hqe2e${test.info().parallelIndex}`
  const response = await fetch(`${serverUrl}/api/mutate?schema=${appId}_0&appID=${appId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenOf(workerStack, user)}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [
        {
          type: 'custom',
          id: 1,
          clientID: crypto.randomUUID(),
          name,
          args: [{ workspaceId: 'workspace-acme', ...args }],
          timestamp: Date.now(),
        },
      ],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  return JSON.stringify(await response.json())
}
const craftedRoutingWrite = (workerStack: WorkerStack, user: string, args: object) =>
  craftedMutation(workerStack, user, 'conversation.updateChatRouting', args)
const sessionFieldsOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select harness, local_session from chats where id = ${chatId}`)[0]

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. New chat offers only Channel and Runtime, even to a member with a machine', async ({ page, machine }) => {
  await machine(signedInMachine)
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await expect(dialog.getByRole('radio')).toHaveCount(2)
  await expect(dialog.getByRole('radio', { name: 'Channel' })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Runtime' })).toBeVisible()
})

test('2. the owner picks My machine · Claude Code before prompting: the subscription launch on the machine, then Runs on is read-only', async ({
  page,
  workerStack,
  machine,
}) => {
  const { id: machineId } = await machine(signedInMachine)
  const chatId = await newMachineChat(page, 'Picked my machine')
  await sendMessage(page, 'Hello from the chip')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible(agentReply)

  const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
  expect(runtime?.host_id).toBe(machineId)
  const { conversations } = await machine()
  expect(conversations).toHaveLength(1)
  expect(conversations[0]?.agent).toMatchObject({ acp_command: subscriptionCommand })
  expect(conversations[0]?.secrets).toEqual({})
  expect(JSON.stringify(conversations[0])).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|base_url/)
  await openSession(page)
  await expect(runsOnOf(page)).toHaveCount(0)
  await expect(sessionOf(page)).toContainText(`Runs on ${claudeOnMachine}`)
})

test('3. a new runtime chat left on HQ runtime runs on a workspace host with the member key', async ({
  page,
  workerStack,
  machine,
  agentScript,
}) => {
  const { id: machineId } = await machine(signedInMachine)
  const chatId = await newRuntimeChat(page, 'Left on HQ runtime')
  await openSession(page)
  await expect(runsOnOf(page)).toHaveValue('runtime')
  await page.keyboard.press('Escape')
  await agentScript(chatId, { text: 'Answered on an HQ runtime.' })
  await sendMessage(page, 'Hello HQ runtime')
  await expect(repliesWith(page, 'Answered on an HQ runtime.')).toBeVisible(agentReply)
  await expect(chipOf(page)).toHaveText(/· auto$/)

  const [runtime] = await workerStack.database.$client`
    select runtime_hosts.id, runtime_hosts.owner_id from runtimes join runtime_hosts on runtime_hosts.id = runtimes.host_id
    where runtimes.chat_id = ${chatId}`
  expect(runtime?.id).not.toBe(machineId)
  expect(runtime?.owner_id).toBeNull()
  expect((await machine()).conversations).toHaveLength(0)
  const query = `metadata_chat=${chatId}&metadata_database=${workerStack.databaseName}&limit=10`
  await expect
    .poll(
      async () => ((await workerStack.gateway<{ logs: object[] | null }>(`/api/logs?${query}`)).logs ?? []).length,
      {
        timeout: 20_000,
      },
    )
    .toBeGreaterThanOrEqual(1)
})

test('4. another member does not see the choice, and crafted writes by them or once a conversation exists are refused', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  const chatId = await newRuntimeChat(page, 'Only Alice chooses')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Only Alice chooses')
  await openSession(bobPage)
  await expect(runsOnOf(bobPage)).toHaveCount(0)
  await expect(sessionOf(bobPage)).toContainText('Runs on HQ runtime')
  expect(await craftedRoutingWrite(workerStack, 'member-bob', { chatId, runsOn: 'claude-code' })).toContain(
    'Only the owner changes how this session runs',
  )
  expect(await sessionFieldsOf(workerStack, chatId)).toEqual({ harness: null, local_session: false })
  await bobPage.context().close()

  await openSession(page)
  await runsOnOf(page).selectOption({ label: claudeOnMachine })
  await expect(chipOf(page)).toHaveText('Claude Code · subscription')
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Lock it')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible(agentReply)
  expect(await craftedRoutingWrite(workerStack, 'member-alice', { chatId, runsOn: 'runtime' })).toContain(
    'This session has started; where it runs no longer changes',
  )
  expect(await sessionFieldsOf(workerStack, chatId)).toEqual({ harness: 'claude-code', local_session: true })
})

test('5. the chip lists the adapter models, a pick is switched in place, and a pick before the first prompt switches the session started at the choice', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await newMachineChat(page, 'First on my machine')
  await sendMessage(page, 'First prompt')
  await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible(agentReply)
  await openSession(page)
  const modelOf = (target: Page) => sessionOf(target).getByRole('combobox', { name: 'Model' })
  await expect(modelOf(page).getByRole('option')).toHaveText(['Default (stub)', 'Large (stub)'])
  await expect(modelOf(page)).toHaveValue('stub-default')
  await modelOf(page).selectOption({ label: 'Large (stub)' })
  await expect(chipOf(page)).toHaveText('Claude Code · Large (stub)')
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Second prompt')
  await expect(repliesWith(page, 'model stub-large')).toBeVisible(agentReply)
  expect((await machine()).modelSwitches).toEqual(['stub-large'])
  await openSession(page)
  await expect(modelOf(page)).toHaveValue('stub-large')
  await page.keyboard.press('Escape')

  await newMachineChat(page, 'Second on my machine')
  await openSession(page)
  await expect(modelOf(page).getByRole('option')).toHaveText(['Default (stub)', 'Large (stub)'])
  await expect(modelOf(page)).toHaveValue('stub-default')
  await modelOf(page).selectOption({ label: 'Large (stub)' })
  await expect(chipOf(page)).toHaveText('Claude Code · Large (stub)')
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Prompt on Large')
  await expect(repliesWith(page, 'model stub-large')).toHaveCount(1, agentReply)
  const { conversations, modelSwitches } = await machine()
  expect(conversations.map((conversation) => conversation.agent.acp_model)).toEqual([undefined, undefined])
  expect(modelSwitches).toEqual(['stub-large', 'stub-large'])
})

test('6. with the workspace switch off the machine options are hidden and an existing machine chat gets the turned-off notice', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await newMachineChat(page, 'Machine before the switch')
  await sendMessage(page, 'Before the switch')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible(agentReply)
  await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0, agentReply)

  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  const localSessionsSwitch = mainOf(page)
    .getByRole('region', { name: 'Runtime hosts' })
    .getByRole('switch', { name: 'Members can run sessions on their own machine' })
  await localSessionsSwitch.click()
  await expect(localSessionsSwitch).toHaveAttribute('aria-checked', 'false')

  await newRuntimeChat(page, 'After the switch', null)
  await expectRunsOnChosen(page, 'HQ runtime')
  await page.keyboard.press('Escape')
  await openChat(page, 'Machine before the switch')
  await sendMessage(page, 'While it is off')
  await expect(repliesWith(page, "Sessions on members' machines are turned off for this workspace")).toHaveCount(
    1,
    agentReply,
  )
  expect((await machine()).prompts).toEqual(['Before the switch'])
})

test('8. a new runtime chat shows Runs on with nothing chosen and Send blocked until a pick', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await newRuntimeChat(page, 'Choose first', null)
  await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine])
  await page.getByRole('textbox', { name: 'Message' }).fill('Not yet')
  await expect(sendButtonOf(page)).toBeDisabled()
  await expect(mainOf(page)).toContainText('Choose where this chat runs to send')
  await chooseRunsOn(page, 'HQ runtime')
  await expect(sendButtonOf(page)).toBeEnabled()
})

test('9. before the owner chooses, another member waits and their crafted prompt is refused', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  const chatId = await newRuntimeChat(page, 'Alice has not chosen', null)
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Alice has not chosen')
  await expect(runsOnChoiceOf(bobPage)).toHaveCount(0)
  await expect(mainOf(bobPage)).toContainText('Waiting for Alice to choose where this chat runs')
  await expect(sendButtonOf(bobPage)).toBeDisabled()
  await bobPage.context().close()
  expect(
    await craftedMutation(workerStack, 'member-bob', 'conversation.sendMessage', {
      id: crypto.randomUUID(),
      chatId,
      text: 'Sneaking in',
    }),
  ).toContain('Waiting for Alice to choose where this chat runs')
  expect(await workerStack.database.$client`select 1 from messages where chat_id = ${chatId}`).toHaveLength(0)
})

test('11. a removed machine offers no machine option', async ({ page, machine }) => {
  await machine(signedInMachine)
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  const machineSection = mainOf(page).getByRole('region', { name: 'My machine' })
  await machineSection.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('dialog', { name: 'Remove my machine' }).getByRole('button', { name: 'Remove' }).click()
  await expect(machineSection.getByRole('button', { name: 'Add my machine' })).toBeVisible()
  await newRuntimeChat(page, 'After removing my machine', null)
  await expectRunsOnChosen(page, 'HQ runtime')
})

test('12. clicking outside the open chip closes it', async ({ page }) => {
  await newRuntimeChat(page, 'Click away')
  await openSession(page)
  await mainOf(page).getByRole('heading', { level: 1, name: 'Click away' }).click()
  await expect(sessionOf(page)).toHaveCount(0)
})

test('13. only the signed-in tool of an online machine is offered, without a sign-in notice', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await newRuntimeChat(page, 'Claude only', null)
  await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine])
  await expect(runsOnChoiceOf(page)).not.toContainText('Sign in')
})

test('14. a machine signed in to both tools offers both', async ({ page, machine }) => {
  await machine({ owner: 'member-alice', signedIn: 'claude,codex' })
  await newRuntimeChat(page, 'Both tools', null)
  await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine, 'My machine · Codex'])
})

test('15. an offline machine offers no machine option until it is back online', async ({ page, machine }) => {
  await machine(signedInMachine)
  await machine({ online: 'false' })
  await newRuntimeChat(page, 'Laptop asleep', null)
  await expectRunsOnChosen(page, 'HQ runtime')
  await page.keyboard.press('Escape')
  await machine({ online: 'true' })
  await openSession(page)
  await expect(runsOnOf(page).getByRole('option')).toHaveText(['HQ runtime', claudeOnMachine])
})

test('16. a machine signed in to neither tool offers HQ runtime only', async ({ page, machine }) => {
  await machine({ owner: 'member-alice', signedIn: '' })
  await newRuntimeChat(page, 'No sign-in', null)
  await expectRunsOnChosen(page, 'HQ runtime')
})

test.describe('without a workspace host', () => {
  test.use({ runtimeHost: false })

  test('10. HQ runtime gives the no-host notice, then switching to My machine · Claude Code answers on the machine', async ({
    page,
    workerStack,
    machine,
  }) => {
    const { id: machineId } = await machine(signedInMachine)
    await machine({ online: 'false' })
    const chatId = await newRuntimeChat(page, 'No host first')
    await sendMessage(page, 'First try')
    await expect(repliesWith(page, 'No runtime host is available')).toHaveCount(1, agentReply)
    await machine({ online: 'true' })
    await openSession(page)
    await runsOnOf(page).selectOption({ label: claudeOnMachine })
    await expect(chipOf(page)).toHaveText('Claude Code · subscription')
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Second try')
    await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(2, agentReply)
    const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
    expect(runtime?.host_id).toBe(machineId)
    await expect.poll(async () => (await machine()).prompts, agentReply).toEqual(['First try', 'Second try'])
  })
})
