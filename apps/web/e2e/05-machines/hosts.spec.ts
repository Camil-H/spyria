import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPageAs } from '../stack'
import { viteUrl } from '../stack-ports'
import {
  addLlmKey,
  addParticipant,
  test as base,
  expect,
  hostsSectionOf,
  llmSectionOf,
  machineSectionOf,
  machineToolOf,
  mainOf,
  messageItemsOf,
  openChat,
  openProfile,
  openSettings,
  type Page,
  sendMessage,
  sidebarOf,
  urlOf,
} from './fixtures'

const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const gibibyte = 1024 ** 3

type HostSystem = { cpus: number; memoryBytes: number; rootless: boolean; limitsEnforced: boolean }
type HostProcess = { output: () => string; exited: Promise<number | null>; stop: () => Promise<void> }
type FakeHost = { closed: Promise<string> }
type Hosts = {
  start: (url: string, stateDirectory?: string) => HostProcess
  newStateDirectory: () => string
  fake: (url: string, system: Partial<HostSystem>) => FakeHost
}

type FakeMachine = { closed: Promise<string>; heartbeat: (signedIn: string[]) => void }
type PairingOptions = { personal?: boolean; signedIn?: string[] }

const test = base.extend<{ hosts: Hosts; pair: (url: string, options: PairingOptions) => FakeMachine }>({
  hosts: async ({ browserName: _ }, use) => {
    const processes: ChildProcess[] = []
    const sockets: WebSocket[] = []
    const stateDirectories: string[] = []
    const newStateDirectory = () => {
      const directory = mkdtempSync(join(tmpdir(), 'hq-test-host-'))
      stateDirectories.push(directory)
      return directory
    }
    await use({
      newStateDirectory,
      start: (url, stateDirectory = newStateDirectory()) => {
        const child = spawn('bun', [hostProgram, url], {
          env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: 'hq-test-e2e-' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        processes.push(child)
        let output = ''
        const collect = (chunk: Buffer) => {
          output += chunk.toString()
        }
        child.stdout?.on('data', collect)
        child.stderr?.on('data', collect)
        const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
        return {
          output: () => output,
          exited,
          stop: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.kill('SIGTERM')
            await exited
          },
        }
      },
      fake: (url, system) => {
        const { origin, pathname } = new URL(url)
        const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
        sockets.push(socket)
        const send = (frame: object) => socket.send(JSON.stringify(frame))
        socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
        socket.onmessage = (message) => {
          const frame = JSON.parse(String(message.data))
          if (frame.type === 'ping') send({ type: 'pong' })
          if (frame.type === 'token')
            send({
              type: 'hello',
              token: frame.token,
              system: {
                cpus: 4,
                memoryBytes: 8 * gibibyte,
                dockerVersion: '29.0.0',
                rootless: false,
                cgroupDriver: 'systemd',
                limitsEnforced: true,
                ...system,
              },
            })
        }
        return { closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.reason))) }
      },
    })
    for (const socket of sockets) socket.close()
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const directory of stateDirectories) rmSync(directory, { recursive: true, force: true })
  },
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

test.describe('Workspace runtime hosts', () => {
  const hostRowOf = (page: Page, hostName: string) =>
    hostsSectionOf(page).getByRole('listitem').filter({ hasText: hostName })
  const addDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Add runtime host' })
  const commandOf = (page: Page, dialogName = 'Add runtime host') =>
    page.getByRole('dialog', { name: dialogName }).getByRole('textbox', { name: 'Command' })

  const addHost = async (page: Page, hostName: string) => {
    await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
    await addDialogOf(page).getByRole('textbox', { name: 'Host name' }).fill(hostName)
    await addDialogOf(page).getByRole('button', { name: 'Add' }).click()
    const command = await commandOf(page).inputValue()
    await addDialogOf(page).getByRole('button', { name: 'Close' }).click()
    return urlOf(command)
  }

  const dockerSystem = () => {
    const info = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}']).toString())
    return {
      cpus: info.NCPU as number,
      memoryBytes: info.MemTotal as number,
      rootless: ((info.SecurityOptions ?? []) as string[]).some((option) => option.includes('rootless')),
    }
  }

  const expectOnline = async (page: Page, hostName: string) => {
    await expect(hostRowOf(page, hostName)).toContainText('Online', { timeout: 10_000 })
  }

  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test.describe('who can manage runtime hosts', () => {
    test('an admin opens Workspace settings from the sidebar and sees an empty Runtime hosts section', {
      tag: ['@spec-07'],
    }, async ({ page }) => {
      await openSettings(page, 'Connect runtime')
      await expect(hostsSectionOf(page).getByRole('heading', { level: 2, name: 'Runtime hosts' })).toBeVisible()
      await expect(hostsSectionOf(page).getByText('No runtime host yet')).toBeVisible()
    })

    test.describe('as a member', () => {
      test.use({ signedInAs: 'member-bob' })

      test('a member has no settings link and the settings URL is refused', { tag: ['@spec-07'] }, async ({ page }) => {
        await expect(sidebarOf(page).getByRole('link', { name: 'Profile' })).toBeVisible()
        await expect(sidebarOf(page).getByRole('link', { name: 'Workspace settings' })).toHaveCount(0)
        await page.goto('/w/workspace-acme/settings/runtime')
        await expect(mainOf(page).getByText('Only workspace admins can see this page')).toBeVisible()
        await expect(hostsSectionOf(page)).toHaveCount(0)
      })
    })
  })

  test('adding a host shows one copyable command that replaces hq-host and picks rootless or rooted Docker itself; Copy reads ✓ Copied', {
    tag: ['@spec-07', '@spec-25', '@stage-g'],
  }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openSettings(page, 'Connect runtime')
    await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
    await addDialogOf(page).getByRole('textbox', { name: 'Host name' }).fill('Home server')
    await addDialogOf(page).getByRole('button', { name: 'Add' }).click()

    await expect(addDialogOf(page).getByRole('switch', { name: 'Rootless Docker' })).toHaveCount(0)
    await expect(addDialogOf(page)).toContainText('within 15 minutes, from the HQ repo folder')
    const command = await commandOf(page).inputValue()
    expect(command).toMatch(
      /^docker build -q -t hq-host apps\/host >\/dev\/null && docker rm -f hq-host .*; docker volume rm hq-host /,
    )
    expect(command).toContain('docker run')
    expect(command).toContain('--restart unless-stopped')
    expect(command).toContain('grep -q rootless')
    expect(command).toContain('-v $XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock')
    expect(command).toContain('-v /var/run/docker.sock:/var/run/docker.sock')
    expect(command).toContain('--add-host host.docker.internal:host-gateway')
    expect(command).not.toContain('--personal')
    expect(command).not.toContain('login')
    const dockerOrigin = viteUrl.replace('localhost', 'host.docker.internal')
    expect(command).toMatch(new RegExp(` hq-host ${dockerOrigin}/h/[A-HJ-NP-Z2-9]{8}$`))

    await addDialogOf(page).getByRole('button', { name: 'Copy' }).click()
    await expect(addDialogOf(page).getByRole('button', { name: '✓ Copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command)
    await addDialogOf(page).getByRole('button', { name: 'Close' }).click()
    await expect(addDialogOf(page)).toHaveCount(0)
    await expect(hostRowOf(page, 'Home server')).toContainText('Waiting for the host')
  })

  test('a host’s lifecycle: online with its capacity, its code works once, offline and back with its stored token, then removed after confirmation and refused', {
    tag: ['@spec-07', '@smoke'],
  }, async ({ page, hosts }) => {
    await openSettings(page, 'Connect runtime')
    const url = await addHost(page, 'Home server')
    const stateDirectory = hosts.newStateDirectory()
    const firstRun = hosts.start(url, stateDirectory)
    await test.step('starting hq-host with the displayed URL turns the row Online with its capacity', async () => {
      await expectOnline(page, 'Home server')
      const { cpus, memoryBytes, rootless } = dockerSystem()
      const cap = Math.max(1, Math.floor((memoryBytes - 2 * gibibyte) / gibibyte))
      const row = hostRowOf(page, 'Home server')
      await expect(row).toContainText(`${cpus} CPUs`)
      await expect(row).toContainText(`${(memoryBytes / gibibyte).toFixed(1)} GB`)
      await expect(row).toContainText(`0 / ${cap}`)
      await expect(row.getByText(rootless ? 'Docker: rootless' : 'Docker: root', { exact: true })).toBeVisible()
    })
    await test.step('a second hq-host with the same URL is refused and the first stays online', async () => {
      const secondHost = hosts.start(url)
      expect(await secondHost.exited).not.toBe(0)
      expect(secondHost.output()).toContain('This code was already used')
      await expect(hostRowOf(page, 'Home server')).toContainText('Online')
    })
    const secondRun =
      await test.step('a stopped host goes Offline and comes back Online with its stored token', async () => {
        await firstRun.stop()
        await expect(hostRowOf(page, 'Home server')).toContainText('Offline', { timeout: 60_000 })
        const run = hosts.start(url, stateDirectory)
        await expectOnline(page, 'Home server')
        return run
      })
    await test.step('removing an online host asks for confirmation, disconnects it and refuses it afterwards', async () => {
      await hostRowOf(page, 'Home server').getByRole('button', { name: 'Remove' }).click()
      const confirmation = page.getByRole('dialog', { name: 'Remove runtime host' })
      await expect(confirmation).toContainText('Home server')
      await confirmation.getByRole('button', { name: 'Remove' }).click()
      await expect(hostRowOf(page, 'Home server')).toHaveCount(0)
      await expect(hostsSectionOf(page).getByText('No runtime host yet')).toBeVisible()
      expect(await secondRun.exited).not.toBe(0)
      expect(secondRun.output()).toContain('This host was removed')
    })
  })

  test('an expired code is refused, the row shows Code expired and New command pairs the same row', {
    tag: ['@spec-07'],
  }, async ({ page, hosts, workerStack }) => {
    await openSettings(page, 'Connect runtime')
    const expiredUrl = await addHost(page, 'Home server')
    await workerStack.database.$client`update runtime_hosts set claim_expires_at = now() - interval '1 second'`
    await expect(hostRowOf(page, 'Home server')).toContainText('Code expired')
    const refusedHost = hosts.start(expiredUrl)
    expect(await refusedHost.exited).not.toBe(0)
    expect(refusedHost.output()).toContain('This code has expired')

    await hostRowOf(page, 'Home server').getByRole('button', { name: 'New command' }).click()
    const freshUrl = urlOf(await commandOf(page, 'New command').inputValue())
    expect(freshUrl).not.toBe(expiredUrl)
    await page.getByRole('dialog', { name: 'New command' }).getByRole('button', { name: 'Close' }).click()
    await expect(hostRowOf(page, 'Home server')).toContainText('Waiting for the host')
    hosts.start(freshUrl)
    await expectOnline(page, 'Home server')
    await expect(hostsSectionOf(page).getByRole('listitem')).toHaveCount(1)
  })

  test('host badges show Docker: root or Docker: rootless with a tooltip, and limits that are not enforced', {
    tag: ['@spec-07', '@spec-25', '@stage-f'],
  }, async ({ page, hosts }) => {
    await openSettings(page, 'Connect runtime')
    hosts.fake(await addHost(page, 'Rooted box'), { rootless: false, limitsEnforced: true })
    hosts.fake(await addHost(page, 'Rootless box'), { rootless: true, limitsEnforced: false })
    await expectOnline(page, 'Rooted box')
    await expectOnline(page, 'Rootless box')
    const rootedRow = hostRowOf(page, 'Rooted box')
    const rootlessRow = hostRowOf(page, 'Rootless box')
    await expect(rootedRow.getByText('Docker: root', { exact: true })).toHaveAttribute(
      'title',
      'Docker on this host runs as root: containers are isolated but the daemon has root on the host',
    )
    await expect(rootedRow.getByText('Limits not enforced')).toHaveCount(0)
    await expect(rootlessRow.getByText('Docker: rootless', { exact: true })).toHaveAttribute(
      'title',
      'Docker runs without root on this host',
    )
    await expect(rootlessRow.getByText('Limits not enforced')).toBeVisible()
    await expect(rootedRow).toContainText('4 CPUs')
    await expect(rootedRow).toContainText('8.0 GB')
    await expect(rootedRow).toContainText('0 / 6')
  })
})

test.describe('Members’ own machines', () => {
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
    await openSettings(page, 'Connect runtime')
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

    test('a member adds their machine: it pairs as personal, shows online in their profile only and is counted for admins', {
      tag: ['@spec-20'],
    }, async ({ page, browser, workerStack, pair }) => {
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
      await openSettings(adminPage, 'Connect runtime')
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

    test('Profile has one My machine section apart from LLM access: the machine, its status and Remove, then the Use Claude Code and Use Codex buttons with their state', {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, pair }) => {
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

    test('Use Claude Code without a machine shows one command that starts the machine and signs in, then follows it to Online and ready; My machine shows it Online', {
      tag: ['@spec-23'],
    }, async ({ page, pair }) => {
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

    test('Use Codex on a machine signed in to Claude only shows only the Codex sign-in command', {
      tag: ['@spec-23'],
    }, async ({ page, pair }) => {
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

  test('a machine paired without --personal and a workspace host paired with --personal are refused with the restart notice', {
    tag: ['@spec-20'],
  }, async ({ page, pair }) => {
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

  test('with only a machine online, ordinary runtime chats of its owner and of another member wait with the no-host notice', {
    tag: ['@spec-20'],
  }, async ({ page, browser, workerStack, pair }) => {
    pair(urlOf(await addMachine(page)), { personal: true, signedIn: ['claude'] })
    await expect(machineSectionOf(page)).toContainText('Online')

    await openChat(page, 'Research')
    await sendMessage(page, 'Run this on any host')
    await expect(messageItemsOf(page).filter({ hasText: 'No runtime host is available' })).toHaveCount(1)

    await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Anthropic')
    await openChat(bobPage, 'Research')
    await sendMessage(bobPage, 'Bob tries too')
    await expect(messageItemsOf(bobPage).filter({ hasText: 'No runtime host is available' })).toHaveCount(2)
    await bobPage.context().close()
  })
})
