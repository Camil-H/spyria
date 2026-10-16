import {
  addLlmKey,
  test as base,
  expect,
  hostsSectionOf,
  llmSectionOf,
  machineSectionOf,
  machineToolOf,
  messageItemsOf,
  openChat,
  openProfile,
  openSettings,
  type Page,
  sendMessage,
  urlOf,
} from './fixtures'
import { openPageAs } from './stack'

type FakeMachine = { closed: Promise<string>; heartbeat: (signedIn: string[]) => void }
type PairingOptions = { personal?: boolean; signedIn?: string[] }

const test = base.extend<{ pair: (url: string, options: PairingOptions) => FakeMachine }>({
  pair: async ({ browserName: _ }, use) => {
    const sockets: WebSocket[] = []
    await use((url, { personal, signedIn }) => {
      const { origin, pathname } = new URL(url)
      const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
      sockets.push(socket)
      const send = (frame: object) => socket.send(JSON.stringify(frame))
      socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data))
        if (frame.type === 'ping') send({ type: 'pong' })
        if (frame.type === 'cmd') send({ type: 'res', id: frame.id, data: frame.op === 'status' ? 'missing' : null })
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
        heartbeat: (heartbeatSignedIn) =>
          send({ type: 'heartbeat', memoryFreeBytes: 8 * 1024 ** 3, running: 0, signedIn: heartbeatSignedIn }),
        closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.reason))),
      }
    })
    for (const socket of sockets) socket.close()
  },
})

const useToolDialogOf = (page: Page, toolName: string) => page.getByRole('dialog', { name: `Use ${toolName}` })

const addMachine = async (page: Page) => {
  await openProfile(page)
  await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add my machine' })
  const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return command
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
    await expect(machineSectionOf(page)).toContainText('Online')
    await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
    await expect(machineToolOf(page, 'Codex')).toHaveText('Use Codex')
    await expect(machineSectionOf(page)).not.toContainText('docker exec')
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
})

test.describe('Use Claude Code and Use Codex, as a member', () => {
  test.use({ signedInAs: 'member-bob' })

  test('f-8. Profile has one My machine section apart from LLM access: the machine, its status and Remove, then the Use Claude Code and Use Codex buttons with their state', async ({
    page,
    pair,
  }) => {
    await openProfile(page)
    await expect(llmSectionOf(page)).not.toContainText('Claude Code')
    await expect(llmSectionOf(page)).not.toContainText('Codex')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toBeVisible()
    for (const toolName of ['Claude Code', 'Codex'])
      await expect(machineToolOf(page, toolName)).toHaveText(`Use ${toolName}`)

    pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['codex'] })
    await expect(machineSectionOf(page).getByText('Online', { exact: true })).toHaveCount(1)
    await expect(machineSectionOf(page).getByRole('button', { name: 'Remove' })).toBeVisible()
    await expect(machineSectionOf(page).getByRole('button', { name: 'Add my machine' })).toHaveCount(0)
    const codexState = machineToolOf(page, 'Codex')
    await expect(codexState).toHaveText('✓ Codex connected')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Use Codex' })).toHaveCount(0)
    await expect(machineToolOf(page, 'Claude Code')).toHaveText('Use Claude Code')
    await expect(machineSectionOf(page)).not.toContainText('Signed in to')
    const connectedColour = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('span'))
      probe.style.color = 'light-dark(var(--color-green-900), var(--color-green-400))'
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    })
    expect(await codexState.evaluate((state) => getComputedStyle(state).color)).toBe(connectedColour)
    const [removeBottom, toolsTop] = await Promise.all([
      machineSectionOf(page)
        .getByRole('button', { name: 'Remove' })
        .evaluate((button) => button.getBoundingClientRect().bottom),
      machineToolOf(page, 'Claude Code').evaluate((button) => button.getBoundingClientRect().top),
    ])
    expect(removeBottom).toBeLessThanOrEqual(toolsTop)
  })

  test('8. Use Claude Code without a machine shows one command that starts the machine and signs in, then follows it to Online and ready; My machine shows it Online', async ({
    page,
    pair,
  }) => {
    await openProfile(page)
    await machineToolOf(page, 'Claude Code').click()
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
    await expect(dialog).toContainText('Your machine: Online')
    await expect(commandBox).toHaveValue('docker exec -it hq-host hq-host login claude')
    machine.heartbeat(['claude'])
    await expect(dialog).toContainText(
      'Claude Code is ready: in a new Runtime chat, set Runs on to Local · Claude Code',
    )
    await expect(commandBox).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close' }).click()

    await expect(machineSectionOf(page)).toContainText('Online')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Remove' })).toBeVisible()
    await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Use Claude Code' })).toHaveCount(0)
  })

  test('9. Use Codex on a machine signed in to Claude only shows only the Codex sign-in command', async ({
    page,
    pair,
  }) => {
    pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
    await expect(machineSectionOf(page)).toContainText('Online')
    await expect(machineToolOf(page, 'Claude Code')).toHaveText('✓ Claude Code connected')
    await expect(machineSectionOf(page).getByRole('button', { name: 'Use Claude Code' })).toHaveCount(0)
    await expect(machineToolOf(page, 'Codex')).toHaveText('Use Codex')
    await expect(machineSectionOf(page)).not.toContainText('docker exec')
    await machineToolOf(page, 'Codex').click()
    const dialog = useToolDialogOf(page, 'Codex')
    await expect(dialog.getByRole('textbox', { name: 'Command' })).toHaveValue(
      'docker exec -it hq-host hq-host login codex',
    )
    await expect(dialog.getByRole('textbox')).toHaveCount(1)
    await expect(dialog).not.toContainText('docker build')
    await expect(dialog).not.toContainText('is ready')
  })
})

test('2. a machine paired without --personal and a workspace host paired with --personal are refused with the restart notice', async ({
  page,
  pair,
}) => {
  await test.step('a machine paired without --personal', async () => {
    const machine = pair(urlOf(await addMachine(page)), {})
    expect(await machine.closed).toBe('This host was paired as your machine: restart hq-host with --personal')
    await expect(machineSectionOf(page)).toContainText('Offline')
  })
  await test.step('a workspace host paired with --personal', async () => {
    const command = await addWorkspaceHost(page)
    expect(command).not.toContain('--personal')
    const host = pair(urlOf(command), { personal: true, signedIn: [] })
    expect(await host.closed).toBe('This host was paired as a workspace host: restart hq-host without --personal')
    await expect(hostsSectionOf(page).getByRole('listitem').filter({ hasText: 'Workspace box' })).toContainText(
      'Offline',
    )
  })
})

test('7. with only a machine online, ordinary runtime chats of its owner and of another member wait with the no-host notice', async ({
  page,
  browser,
  workerStack,
  pair,
}) => {
  pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
  await expect(machineSectionOf(page)).toContainText('Online')

  await openChat(page, 'Research')
  await sendMessage(page, 'Run this on any host')
  await expect(messageItemsOf(page).filter({ hasText: 'No runtime host is available' })).toHaveCount(1)

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Anthropic')
  await openChat(bobPage, 'Research')
  await sendMessage(bobPage, 'Bob tries too')
  await expect(messageItemsOf(bobPage).filter({ hasText: 'No runtime host is available' })).toHaveCount(2)
  await bobPage.context().close()
})
