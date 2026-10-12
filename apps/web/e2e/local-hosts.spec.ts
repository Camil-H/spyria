import { test as base, expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, sidebarOf } from './fixtures'
import { openPageAs } from './stack'
import { viteUrl } from './stack-ports'

type FakeMachine = { closed: Promise<string>; commands: string[]; heartbeat: (signedIn: string[]) => void }
type PairingOptions = { personal?: boolean; signedIn?: string[] }

const test = base.extend<{ pair: (url: string, options: PairingOptions) => FakeMachine }>({
  pair: async ({ browserName: _ }, use) => {
    const sockets: WebSocket[] = []
    await use((url, { personal, signedIn }) => {
      const { origin, pathname } = new URL(url)
      const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
      sockets.push(socket)
      const commands: string[] = []
      const send = (frame: object) => socket.send(JSON.stringify(frame))
      socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data))
        if (frame.type === 'ping') send({ type: 'pong' })
        if (frame.type === 'cmd') {
          commands.push(frame.op)
          send({ type: 'res', id: frame.id, data: frame.op === 'status' ? 'missing' : null })
        }
        if (frame.type === 'token')
          send({
            type: 'hello',
            token: frame.token,
            personal,
            signedIn,
            system: {
              cpus: 8,
              memoryBytes: 16 * 1024 ** 3,
              dockerVersion: '29.0.0',
              rootless: false,
              cgroupDriver: 'cgroupfs',
              limitsEnforced: true,
            },
          })
      }
      return {
        commands,
        heartbeat: (heartbeatSignedIn) =>
          send({ type: 'heartbeat', memoryFreeBytes: 8 * 1024 ** 3, running: 0, signedIn: heartbeatSignedIn }),
        closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.reason))),
      }
    })
    for (const socket of sockets) socket.close()
  },
})

const machineSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My machine' })
const llmSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'LLM access' })
const useToolDialogOf = (page: Page, toolName: string) => page.getByRole('dialog', { name: `Use ${toolName}` })
const hostsSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Runtime hosts' })
const urlOf = (command: string) => `${viteUrl}/h/${command.match(/\/h\/([A-Z0-9]{8})\b/)?.[1]}`

const openProfile = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
}
const openSettings = async (page: Page) => {
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
}
const addMachine = async (page: Page) => {
  await openProfile(page)
  await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add my machine' })
  const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return command
}
const addLlmKey = async (page: Page) => {
  await openProfile(page)
  const llmSection = mainOf(page).getByRole('region', { name: 'LLM access' })
  await llmSection.getByLabel('Provider').fill('Anthropic')
  await llmSection.getByLabel('Secret').fill(`fake-key-${crypto.randomUUID()}`)
  await llmSection.getByRole('button', { name: 'Add' }).click()
  await expect(llmSection.getByRole('listitem').filter({ hasText: 'Anthropic' })).toBeVisible()
}
const addWorkspaceHost = async (page: Page) => {
  await openSettings(page)
  await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add runtime host' })
  await dialog.getByRole('textbox', { name: 'Host name' }).fill('Workspace box')
  await dialog.getByRole('button', { name: 'Add' }).click()
  const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return command
}

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('1. a member adds their machine: it pairs as personal, shows online in their profile only and is counted for admins', async ({
    page,
    browser,
    workerStack,
    pair,
  }) => {
    await openProfile(page)
    await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add my machine' })
    await expect(dialog).toContainText(
      "This runs HQ's agent container on this computer. Your sign-ins never leave this computer.",
    )
    await expect(dialog).toContainText('Never run it on a machine others use.')
    const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
    expect(command).toContain('docker run')
    expect(command).toMatch(/ hq-host --personal https?:\/\/\S+\/h\/[A-HJ-NP-Z2-9]{8}$/)
    await dialog.getByRole('button', { name: 'Close' }).click()

    pair(urlOf(command), { personal: true, signedIn: ['claude'] })
    await expect(machineSectionOf(page)).toContainText('Online', { timeout: 10_000 })
    await expect(machineSectionOf(page)).toContainText('Signed in to Claude Code')
    await expect(machineSectionOf(page)).toContainText(
      'Not signed in to Codex: docker exec -it hq-host hq-host login codex',
    )
    await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)

    const adminPage = await openPageAs(browser, workerStack, 'member-alice')
    await openSettings(adminPage)
    await expect(hostsSectionOf(adminPage)).toContainText('1 member uses their machine')
    await expect(hostsSectionOf(adminPage).getByRole('listitem')).toHaveCount(0)
    await expect(hostsSectionOf(adminPage)).not.toContainText('My machine')
    await openProfile(adminPage)
    await expect(machineSectionOf(adminPage).getByRole('button', { name: 'Add my machine' })).toBeVisible()
    await expect(machineSectionOf(adminPage)).not.toContainText('Online')
    await adminPage.context().close()
  })

  test('2a. a machine paired without --personal is refused with the restart notice', async ({ page, pair }) => {
    const machine = pair(urlOf(await addMachine(page)), {})
    expect(await machine.closed).toBe('This host was paired as your machine: restart hq-host with --personal')
    await expect(machineSectionOf(page)).toContainText('Offline')
  })
})

test.describe('Use Claude Code and Use Codex, as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('8. Use Claude Code without a machine shows one command that starts the machine and signs in, then follows it to Online and ready; My machine shows it Online', async ({
    page,
    pair,
  }) => {
    await openProfile(page)
    await llmSectionOf(page).getByRole('button', { name: 'Use Claude Code' }).click()
    const dialog = useToolDialogOf(page, 'Claude Code')
    await expect(dialog).toContainText(
      'signs in to Claude Code with your own plan. The sign-in never leaves this computer',
    )
    await expect(dialog).toContainText('Never run it on a machine others use.')
    await expect(dialog).toContainText('within 15 minutes, from the HQ repo folder')
    const commandBox = dialog.getByRole('textbox', { name: 'Command' })
    const command = await commandBox.inputValue()
    expect(command).toMatch(/^docker build -q -t hq-host apps\/host >\/dev\/null && docker rm -f hq-host /)
    expect(command).toMatch(
      / hq-host --personal http:\/\/host\.docker\.internal:\d+\/h\/[A-HJ-NP-Z2-9]{8} && docker exec -it hq-host hq-host login claude$/,
    )
    await expect(dialog).toContainText('Your machine: Waiting for the host')

    const machine = pair(urlOf(command), { personal: true, signedIn: [] })
    await expect(dialog).toContainText('Your machine: Online', { timeout: 10_000 })
    await expect(commandBox).toHaveValue('docker exec -it hq-host hq-host login claude')
    machine.heartbeat(['claude'])
    await expect(dialog).toContainText(
      'Claude Code is ready: start a chat with New chat, On my machine · Claude Code subscription',
    )
    await expect(commandBox).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()

    await expect(machineSectionOf(page)).toContainText('Online')
    await expect(machineSectionOf(page)).toContainText('Signed in to Claude Code')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Remove' })).toBeVisible()
  })

  test('9. Use Codex on a machine signed in to Claude only shows only the Codex sign-in command', async ({
    page,
    pair,
  }) => {
    pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
    await expect(machineSectionOf(page)).toContainText('Online', { timeout: 10_000 })
    await llmSectionOf(page).getByRole('button', { name: 'Use Codex' }).click()
    const dialog = useToolDialogOf(page, 'Codex')
    await expect(dialog.getByRole('textbox', { name: 'Command' })).toHaveValue(
      'docker exec -it hq-host hq-host login codex',
    )
    await expect(dialog.getByRole('textbox')).toHaveCount(1)
    await expect(dialog).not.toContainText('docker build')
    await expect(dialog).not.toContainText('is ready')
  })
})

test('2b. a workspace host paired with --personal is refused with the restart notice', async ({ page, pair }) => {
  const command = await addWorkspaceHost(page)
  expect(command).not.toContain('--personal')
  const host = pair(urlOf(command), { personal: true, signedIn: [] })
  expect(await host.closed).toBe('This host was paired as a workspace host: restart hq-host without --personal')
  await expect(hostsSectionOf(page).getByRole('listitem').filter({ hasText: 'Workspace box' })).toContainText('Offline')
})

test('7. with only a local host online, ordinary runtime chats of its owner and of another member wait with the no-host notice', async ({
  page,
  browser,
  workerStack,
  pair,
}) => {
  const machine = pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
  await expect(machineSectionOf(page)).toContainText('Online', { timeout: 10_000 })

  await openChat(page, 'Research')
  await sendMessage(page, 'Run this on any host')
  await expect(messageItemsOf(page).filter({ hasText: 'No runtime host is available' })).toHaveCount(1)

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage)
  await openChat(bobPage, 'Research')
  await sendMessage(bobPage, 'Bob tries too')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'No runtime host is available' })).toHaveCount(2)
  await bobPage.context().close()

  expect(machine.commands).not.toContain('create')
  expect(
    (
      await workerStack.database.$client`
      select count(*)::int as placed from runtimes join runtime_hosts on runtime_hosts.id = runtimes.host_id
      where runtime_hosts.owner_id is not null`
    )[0]?.placed,
  ).toBe(0)
})
