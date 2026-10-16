import {
  chipOf,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  type Page,
  sendMessage,
  signedInMachine,
  machineTest as test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const localOption = 'My machine · Claude Code'
const codexOption = 'My machine · Codex'
const codexMachine = { owner: 'member-alice', signedIn: 'codex' }
const tools = [
  { name: 'Claude Code', login: 'claude' },
  { name: 'Codex', login: 'codex' },
]

const newLocalSession = async (page: Page, name: string, option = localOption) => {
  const chatId = await newRuntimeChat(page, name, option)
  await expect(chipOf(page, 'any')).toHaveText(`${option.replace('My machine · ', '')} · subscription`)
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
    await expect(messageContaining(page, 'Hello from the stub')).toBeVisible()
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
      messageContaining(
        page,
        `Sign in to ${tool.name} on your machine: docker exec -it hq-host hq-host login ${tool.login}`,
      ),
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
  await expect(messageContaining(page, 'Hello from the stub')).toBeVisible()

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Shared laptop session')
  await expect(messageContaining(bobPage, 'Hello from the stub')).toBeVisible()
  await sendMessage(bobPage, 'Bob tries the laptop')
  await expect(messageContaining(bobPage, 'Only the owner prompts a session on their machine')).toHaveCount(1)
  await expect(messageContaining(page, 'Only the owner prompts a session on their machine')).toHaveCount(1)
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
  await expect(messageContaining(page, 'Your machine is offline')).toHaveCount(1)
  await machine({ online: 'true' })
  await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()

  await machine({ online: 'false' })
  await sendMessage(page, 'Wait for my laptop again')
  await expect(messageContaining(page, 'Your machine is offline')).toHaveCount(2)
  await machine({ online: 'true' })
  await expect(messageContaining(page, '[t2] Hello from the stub')).toBeVisible()
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
    await expect(messageContaining(page, '$ npm test').getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
    await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
    await release('linger')
    await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
    await messageItemsOf(page)
      .getByRole('button', { name: /^Worked for .+ · 3 steps$/ })
      .click()
    await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
    const command = messageContaining(page, '$ npm test')
    await expect(command.getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('$ Terminal')
    await expect(mainOf(page)).not.toContainText('Read File')
  })
})
