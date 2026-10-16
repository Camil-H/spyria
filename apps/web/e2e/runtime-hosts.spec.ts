import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, expect, hostsSectionOf, mainOf, openSettings, type Page, sidebarOf, urlOf } from './fixtures'
import { viteUrl } from './stack-ports'

const hostProgram = new URL('../../host/src/main.ts', import.meta.url).pathname
const gibibyte = 1024 ** 3

type HostSystem = { cpus: number; memoryBytes: number; rootless: boolean; limitsEnforced: boolean }
type HostProcess = { output: () => string; exited: Promise<number | null>; stop: () => Promise<void> }
type FakeHost = { closed: Promise<string> }
type Hosts = {
  start: (url: string, stateDirectory?: string) => HostProcess
  newStateDirectory: () => string
  fake: (url: string, system: Partial<HostSystem>) => FakeHost
}

const test = base.extend<{ hosts: Hosts }>({
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
})

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

test.describe('1. access', () => {
  test('an admin opens Workspace settings from the sidebar and sees an empty Runtime hosts section', async ({
    page,
  }) => {
    await openSettings(page)
    await expect(hostsSectionOf(page).getByRole('heading', { level: 2, name: 'Runtime hosts' })).toBeVisible()
    await expect(hostsSectionOf(page).getByText('No runtime host yet')).toBeVisible()
  })

  test.describe('as a member', () => {
    test.use({ signedInAs: 'member-bob' })

    test('a member has no settings link and the settings URL is refused', async ({ page }) => {
      await expect(sidebarOf(page).getByRole('link', { name: 'Profile' })).toBeVisible()
      await expect(sidebarOf(page).getByRole('link', { name: 'Workspace settings' })).toHaveCount(0)
      await page.goto('/w/workspace-acme/settings')
      await expect(mainOf(page).getByText('Only workspace admins can see this page')).toBeVisible()
      await expect(hostsSectionOf(page)).toHaveCount(0)
    })
  })
})

test('2. adding a host shows one copyable command that replaces hq-host and picks rootless or rooted Docker itself', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openSettings(page)
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command)
  await addDialogOf(page).getByRole('button', { name: 'Close' }).click()
  await expect(addDialogOf(page)).toHaveCount(0)
  await expect(hostRowOf(page, 'Home server')).toContainText('Waiting for the host')
})

test('3, 4, 6 and 7. a host’s lifecycle: online with its capacity, its code works once, offline and back with its stored token, then removed after confirmation and refused', async ({
  page,
  hosts,
}) => {
  await openSettings(page)
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
    await expect(row.getByText(rootless ? 'Rootless' : 'Rooted', { exact: true })).toBeVisible()
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

test('5. an expired code is refused, the row shows Code expired and New command pairs the same row', async ({
  page,
  hosts,
  workerStack,
}) => {
  await openSettings(page)
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

test('9. badges show rooted Docker and limits that are not enforced', async ({ page, hosts }) => {
  await openSettings(page)
  hosts.fake(await addHost(page, 'Rooted box'), { rootless: false, limitsEnforced: true })
  hosts.fake(await addHost(page, 'Rootless box'), { rootless: true, limitsEnforced: false })
  await expectOnline(page, 'Rooted box')
  await expectOnline(page, 'Rootless box')
  const rootedRow = hostRowOf(page, 'Rooted box')
  const rootlessRow = hostRowOf(page, 'Rootless box')
  await expect(rootedRow.getByText('Rooted', { exact: true })).toBeVisible()
  await expect(rootedRow.getByText('Limits not enforced')).toHaveCount(0)
  await expect(rootlessRow.getByText('Rootless', { exact: true })).toBeVisible()
  await expect(rootlessRow.getByText('Limits not enforced')).toBeVisible()
  await expect(rootedRow).toContainText('4 CPUs')
  await expect(rootedRow).toContainText('8.0 GB')
  await expect(rootedRow).toContainText('0 / 6')
})
