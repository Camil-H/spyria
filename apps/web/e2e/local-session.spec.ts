import {
  test as base,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  type Page,
  sendMessage,
  serverUrl,
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

const localOption = 'My machine · Claude Code'
const signedInMachine = { owner: 'member-alice', signedIn: 'claude' }
const codexOption = 'My machine · Codex'
const codexMachine = { owner: 'member-alice', signedIn: 'codex' }
const tools = [
  { name: 'Claude Code', login: 'claude' },
  { name: 'Codex', login: 'codex' },
]

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

for (const tool of tools) {
  test(`3. the owner prompts an On my machine ${tool.name} session: the answer, unmetered`, async ({
    page,
    machine,
  }) => {
    await machine({ owner: 'member-alice', signedIn: tool.login })
    await newLocalSession(page, `${tool.name} on my laptop`, `My machine · ${tool.name}`)
    await sendMessage(page, 'Hello from my laptop')
    await expect(repliesWith(page, 'Hello from the stub')).toBeVisible()
    const sidePanel = page.getByRole('region', { name: 'Side panel' })
    await sidePanel.getByRole('tab', { name: 'Usage', exact: true }).click()
    await expect(sidePanel).toContainText('Subscription session on your machine, not metered by HQ')
  })

  test(`4. a prompt while the machine is signed out of ${tool.name} shows its sign-in notice and reaches no agent`, async ({
    page,
    workerStack,
    machine,
  }) => {
    await machine({ owner: 'member-alice', signedIn: tool.login })
    await sessionStarted(
      workerStack,
      await newLocalSession(page, `${tool.name} signed out`, `My machine · ${tool.name}`),
    )
    await machine({ signedIn: '' })
    await sendMessage(page, 'Answer without a sign-in')
    await expect(
      repliesWith(page, `Sign in to ${tool.name} on your machine: docker exec -it hq-host hq-host login ${tool.login}`),
    ).toHaveCount(1)
    expect((await machine()).prompts).toEqual([])
  })
}

test('5. another member reads the session and the answer, and their prompt gets the owner-only notice', async ({
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

test.describe('Codex on a ChatGPT plan', () => {
  test('5. a command pending with no input shows the real command and no spinner once completed, and a read shows its path', async ({
    page,
    machine,
    release,
  }) => {
    await machine(codexMachine)
    await newLocalSession(page, 'Real steps', codexOption)
    await sendMessage(page, 'stub:read stub:tools stub:linger')
    await expect(repliesWith(page, '$ npm test').getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(repliesWith(page, 'Read notes.md')).toBeVisible()
    await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
    await release('linger')
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
