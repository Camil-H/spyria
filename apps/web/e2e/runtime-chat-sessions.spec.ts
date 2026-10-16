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
import { openPageAs } from './stack'

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

const claudeOnMachine = 'My machine · Claude Code'
const codexOnMachine = 'My machine · Codex'
const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }

const chipOf = (page: Page) =>
  mainOf(page).getByRole('button', {
    name: /^Model chosen at first prompt$|^Claude Code · |^Codex · |· (auto|same as main)$/,
  })
const sessionOf = (page: Page) => page.getByRole('dialog', { name: 'Session' })
const runsOnOf = (page: Page) => mainOf(page).getByRole('combobox', { name: 'Runs on' })
const expectRunsOnLocked = async (page: Page) => {
  await expect(runsOnOf(page)).toBeDisabled()
  await expect(runsOnOf(page)).toHaveValue('runtime')
}
const expectRunsOnChoices = async (page: Page, names: string[]) => {
  await expect(runsOnChoiceOf(page).getByRole('radio')).toHaveCount(names.length)
  for (const name of names) await expect(runsOnChoiceOf(page).getByRole('radio', { name })).not.toBeChecked()
}
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const openSession = async (page: Page) => {
  if (!(await sessionOf(page).isVisible())) await chipOf(page).click()
  await expect(sessionOf(page)).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('3. a new runtime chat left on HQ runtime runs on a workspace host with the member key', async ({
  page,
  machine,
  agentScript,
}) => {
  await machine(signedInMachine)
  const chatId = await newRuntimeChat(page, 'Left on HQ runtime')
  await openSession(page)
  await expect(runsOnOf(page)).toHaveValue('runtime')
  await page.keyboard.press('Escape')
  await agentScript(chatId, { text: 'Answered on an HQ runtime.' })
  await sendMessage(page, 'Hello HQ runtime')
  await expect(repliesWith(page, 'Answered on an HQ runtime.')).toBeVisible()
  await expect(chipOf(page)).toHaveText(/· auto$/)
})

test('4. another member does not see the choice, and Runs on locks once a conversation exists', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  await newRuntimeChat(page, 'Only Alice chooses')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Only Alice chooses')
  await openSession(bobPage)
  await expectRunsOnLocked(bobPage)
  await bobPage.context().close()

  await openSession(page)
  await runsOnOf(page).selectOption({ label: claudeOnMachine })
  await expect(chipOf(page)).toHaveText('Claude Code · subscription')
  await page.keyboard.press('Escape')
  await sendMessage(page, 'Lock it')
  await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()
  await openSession(page)
  await expect(runsOnOf(page)).toBeDisabled()
  await expect(runsOnOf(page)).toHaveValue('claude-code')
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

test('9. before the owner chooses, another member waits and cannot send', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await machine(signedInMachine)
  await newRuntimeChat(page, 'Alice has not chosen', null)
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Alice has not chosen')
  await expect(runsOnChoiceOf(bobPage)).toHaveCount(0)
  await expect(mainOf(bobPage)).toContainText('Waiting for Alice to choose where this chat runs')
  await expect(sendButtonOf(bobPage)).toBeDisabled()
  await bobPage.context().close()
})

test('12. clicking outside the open chip closes it', async ({ page }) => {
  await newRuntimeChat(page, 'Click away')
  await openSession(page)
  await mainOf(page).getByRole('heading', { level: 1, name: 'Click away' }).click()
  await expect(sessionOf(page)).toHaveCount(0)
})

test('11. Runs on follows the machine: its sign-ins, going offline and back, and its removal', async ({
  page,
  machine,
}) => {
  await machine(signedInMachine)
  await test.step('New chat offers only Channel and Runtime, even to a member with a machine', async () => {
    await page.getByRole('button', { name: 'New chat' }).click()
    const dialog = page.getByRole('dialog', { name: 'New chat' })
    await expect(dialog.getByRole('radio')).toHaveCount(2)
    await expect(dialog.getByRole('radio', { name: 'Channel' })).toBeVisible()
    await expect(dialog.getByRole('radio', { name: 'Runtime' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })
  await newRuntimeChat(page, 'Follows the machine', null)
  await test.step('only the signed-in tool of an online machine is offered, without a sign-in notice', async () => {
    await expectRunsOnChoices(page, ['HQ runtime', claudeOnMachine])
    await expect(runsOnChoiceOf(page)).not.toContainText('Sign in')
  })
  await chooseRunsOn(page, 'HQ runtime')
  for (const { step, query, options } of [
    {
      step: 'signed in to both tools',
      query: { signedIn: 'claude,codex' },
      options: [claudeOnMachine, codexOnMachine],
    },
    { step: 'offline', query: { online: 'false' }, options: [] },
    { step: 'back online', query: { online: 'true' }, options: [claudeOnMachine, codexOnMachine] },
    { step: 'signed in to neither tool', query: { signedIn: '' }, options: [] },
    { step: 'signed in to Claude Code again', query: { signedIn: 'claude' }, options: [claudeOnMachine] },
  ])
    await test.step(`a machine ${step} offers ${options.join(' and ') || 'HQ runtime only'}`, async () => {
      await machine(query)
      await openSession(page)
      await expect(runsOnOf(page).getByRole('option')).toHaveText(['HQ runtime', ...options])
      if (options.length) await expect(runsOnOf(page)).toBeEnabled()
      else await expectRunsOnLocked(page)
      await expect(sessionOf(page)).not.toContainText('Sign in')
    })
  await page.keyboard.press('Escape')
  await test.step('a removed machine offers no machine option', async () => {
    await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
    const machineSection = mainOf(page).getByRole('region', { name: 'My machine' })
    await machineSection.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('dialog', { name: 'Remove my machine' }).getByRole('button', { name: 'Remove' }).click()
    await expect(machineSection.getByRole('button', { name: 'Add my machine' })).toBeVisible()
    await openChat(page, 'Follows the machine')
    await openSession(page)
    await expectRunsOnLocked(page)
  })
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
    await expect(repliesWith(page, 'No runtime host is available')).toHaveCount(1)
    await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
    await machine({ online: 'true' })
    await openSession(page)
    await runsOnOf(page).selectOption({ label: claudeOnMachine })
    await expect(chipOf(page)).toHaveText('Claude Code · subscription')
    await page.keyboard.press('Escape')
    await sendMessage(page, 'Second try')
    await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(2)
    const [runtime] = await workerStack.database.$client`select host_id from runtimes where chat_id = ${chatId}`
    expect(runtime?.host_id).toBe(machineId)
    await expect.poll(async () => (await machine()).prompts).toEqual(['First try', 'Second try'])
  })
})
