import {
  test as base,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  runsOnChoiceOf,
  sendMessage,
  serverUrl,
  sidebarOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

type Machine = { id: string; conversations: object[]; prompts: string[] }
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

const switchName = 'Members can run sessions on their own machine'
const turnedOffNotice = "Your workspace turned off sessions on members' machines"
const sessionNotice = "Sessions on members' machines are turned off for this workspace"

const hostsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Runtime hosts' })
const machineSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My machine' })
const llmSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'LLM access' })
const switchOf = (page: Page) => hostsSectionOf(page).getByRole('switch', { name: switchName })
const repliesWith = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })

const openSettings = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
}
const setLocalSessions = async (page: Page, isOn: boolean) => {
  await openSettings(page)
  await expect(switchOf(page)).toHaveAttribute('aria-checked', String(!isOn))
  await switchOf(page).click()
  await expect(switchOf(page)).toHaveAttribute('aria-checked', String(isOn))
}
const openNewChat = async (page: Page) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  return page.getByRole('dialog', { name: 'New chat' })
}
const tokenOf = async (workerStack: WorkerStack, user: string) =>
  (
    await (
      await fetch(`${serverUrl}/test/token?db=${workerStack.databaseName}&user=${user}&workspace=workspace-acme`, {
        method: 'POST',
      })
    ).json()
  ).token as string
const localSessionsOf = async (workerStack: WorkerStack) =>
  (await workerStack.database.$client`select local_sessions from workspaces where workspace_id = 'workspace-acme'`)[0]
    ?.local_sessions

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1 and 4. the admin turns sessions on members machines off: no Add my machine, Use Claude Code and Use Codex show the notice, a refused add, no My machine option in the chip', async ({
  page,
  browser,
  workerStack,
  machine,
}) => {
  await setLocalSessions(page, false)

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openProfile(bobPage)
  await expect(machineSectionOf(bobPage)).toContainText(turnedOffNotice)
  await expect(machineSectionOf(bobPage).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)
  for (const toolName of ['Claude Code', 'Codex'])
    await test.step(`Use ${toolName} shows the turned-off notice and no command`, async () => {
      await llmSectionOf(bobPage)
        .getByRole('button', { name: `Use ${toolName}` })
        .click()
      const dialog = bobPage.getByRole('dialog', { name: `Use ${toolName}` })
      await expect(dialog).toContainText(turnedOffNotice)
      await expect(dialog.getByRole('textbox')).toHaveCount(0)
      await expect(dialog).not.toContainText('docker')
      await dialog.getByRole('button', { name: 'Close' }).click()
    })

  const response = await fetch(`${serverUrl}/api/runtime-hosts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await tokenOf(workerStack, 'member-bob')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ personal: true }),
  })
  expect(response.status).toBe(403)
  expect((await response.json()).message).toBe(turnedOffNotice)
  expect(
    await workerStack.database
      .$client`select 1 from runtime_hosts where owner_id = 'member-bob' and removed_at is null`,
  ).toHaveLength(0)

  await machine({ owner: 'member-bob', signedIn: 'claude' })
  await expect(machineSectionOf(bobPage)).toContainText('Online')
  await expect(machineSectionOf(bobPage).getByRole('button', { name: 'Remove' })).toBeVisible()
  const dialog = await openNewChat(bobPage)
  await expect(dialog.getByRole('radio')).toHaveCount(2)
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill('Bob while off')
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Bob while off' })).toBeVisible()
  await expect(runsOnChoiceOf(bobPage)).toHaveCount(0)
  await mainOf(bobPage).getByRole('button', { name: 'Model chosen at first prompt' }).click()
  const session = bobPage.getByRole('dialog', { name: 'Session' })
  await expect(session.getByText('Runs on HQ runtime')).toBeVisible()
  await expect(session.getByRole('combobox', { name: 'Runs on' })).toHaveCount(0)
  await bobPage.context().close()
})

test('2. an existing local session answers prompts with the notice while it is off, and again once it is back on', async ({
  page,
  machine,
}) => {
  await machine({ owner: 'member-alice', signedIn: 'claude' })
  await newRuntimeChat(page, 'Laptop switch', 'My machine · Claude Code')
  await expect(mainOf(page).getByRole('button', { name: 'Claude Code · subscription' })).toBeVisible()
  await sendMessage(page, 'Before the switch')
  await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)

  await setLocalSessions(page, false)
  await openChat(page, 'Laptop switch')
  await expect(repliesWith(page, '[t1] Hello from the stub')).toBeVisible()
  await sendMessage(page, 'While it is off')
  await expect(repliesWith(page, sessionNotice)).toHaveCount(1)
  expect((await machine()).prompts).toEqual(['Before the switch'])

  await setLocalSessions(page, true)
  await openChat(page, 'Laptop switch')
  await sendMessage(page, 'Back on')
  await expect(repliesWith(page, '[t2] Hello from the stub')).toBeVisible()
  expect((await machine()).prompts).toEqual(['Before the switch', 'Back on'])
  await expect(repliesWith(page, sessionNotice)).toHaveCount(1)
})

test('3. a member’s crafted mutation of the switch is refused by the server', async ({ workerStack }) => {
  const appId = `hqe2e${test.info().parallelIndex}`
  const response = await fetch(`${serverUrl}/api/mutate?schema=${appId}_0&appID=${appId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenOf(workerStack, 'member-bob')}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [
        {
          type: 'custom',
          id: 1,
          clientID: crypto.randomUUID(),
          name: 'runtime.setLocalSessions',
          args: [{ workspaceId: 'workspace-acme', isOn: false }],
          timestamp: Date.now(),
        },
      ],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  expect(JSON.stringify(await response.json())).toContain('Only workspace admins can manage runtime hosts')
  expect(await localSessionsOf(workerStack)).toBe(true)
})
