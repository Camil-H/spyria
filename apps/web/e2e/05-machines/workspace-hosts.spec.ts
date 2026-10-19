import { execFileSync } from 'node:child_process'
import { viteUrl } from '../stack-ports'
import {
  expect,
  gibibyte,
  hostsSectionOf,
  machineSectionOf,
  mainOf,
  openProfile,
  openSettings,
  type Page,
  sidebarOf,
  hostTest as test,
  urlOf,
} from './fixtures'

test.describe('Workspace hosts', () => {
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

  test.describe(() => {
    test('As a member who can manage runtime hosts, I open Workspace settings from the sidebar and see an empty Runtime hosts section', {
      tag: ['@spec-07'],
    }, async ({ page }) => {
      await openSettings(page, 'Connect runtime')
      await expect(hostsSectionOf(page).getByRole('heading', { level: 2, name: 'Runtime hosts' })).toBeVisible()
      await expect(hostsSectionOf(page).getByText('No runtime host yet')).toBeVisible()
    })

    test.describe(() => {
      test.use({ signedInAs: 'member-bob' })

      test('As a member without the runtime hosts permission, I have no settings link and the settings URL is refused', {
        tag: ['@spec-07'],
      }, async ({ page }) => {
        await expect(sidebarOf(page).getByRole('link', { name: 'Profile' })).toBeVisible()
        await expect(sidebarOf(page).getByRole('link', { name: 'Workspace settings' })).toHaveCount(0)
        await page.goto('/w/workspace-acme/settings/runtime')
        await expect(mainOf(page).getByText('Your workspace role does not give access to this page')).toBeVisible()
        await expect(hostsSectionOf(page)).toHaveCount(0)
      })
    })
  })

  test('As a member who can manage runtime hosts, I add a host and get one command that replaces spyria-host and picks rootless or rooted Docker itself', {
    tag: ['@spec-07', '@spec-25', '@stage-g'],
  }, async ({ page }) => {
    await openSettings(page, 'Connect runtime')
    await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
    await addDialogOf(page).getByRole('textbox', { name: 'Host name' }).fill('Home server')
    await addDialogOf(page).getByRole('button', { name: 'Add' }).click()

    await expect(addDialogOf(page).getByRole('switch', { name: 'Rootless Docker' })).toHaveCount(0)
    await expect(addDialogOf(page)).toContainText('within 15 minutes, from the Spyria repo folder')
    const command = await commandOf(page).inputValue()
    expect(command).toMatch(
      /^docker build -q -t spyria-host apps\/host >\/dev\/null && docker rm -f hq-host .*; docker volume rm hq-host /,
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
    expect(command).toMatch(new RegExp(` spyria-host ${dockerOrigin}/h/[A-HJ-NP-Z2-9]{8}$`))

    await addDialogOf(page).getByRole('button', { name: 'Close' }).click()
    await expect(addDialogOf(page)).toHaveCount(0)
    await expect(hostRowOf(page, 'Home server')).toContainText('Waiting for the host')
  })

  test('As a member who can manage runtime hosts, I follow a host’s lifecycle: online with its capacity, its code working once, offline and back with its stored token, then removed after confirmation and refused', {
    tag: ['@spec-07', '@smoke'],
  }, async ({ page, hosts }) => {
    await openSettings(page, 'Connect runtime')
    const url = await addHost(page, 'Home server')
    const stateDirectory = hosts.newStateDirectory()
    const firstRun = hosts.start(url, stateDirectory)
    await test.step('starting spyria-host with the displayed URL turns the row Online with its capacity', async () => {
      await expectOnline(page, 'Home server')
      const { cpus, memoryBytes, rootless } = dockerSystem()
      const cap = Math.max(1, Math.floor((memoryBytes - 2 * gibibyte) / gibibyte))
      const row = hostRowOf(page, 'Home server')
      await expect(row).toContainText(`${cpus} CPUs`)
      await expect(row).toContainText(`${(memoryBytes / gibibyte).toFixed(1)} GB`)
      await expect(row).toContainText(`0 / ${cap}`)
      await expect(row.getByText(rootless ? 'Docker: rootless' : 'Docker: root', { exact: true })).toBeVisible()
    })
    await test.step('a second spyria-host with the same URL is refused and the first stays online', async () => {
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

  test('As a member who can manage runtime hosts, I see an expired code refused and marked Code expired, and New command pairs the same row', {
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

  test('As a member who can manage runtime hosts, I see a machine paired without --personal and a workspace host paired with --personal refused with the restart notice', {
    tag: ['@spec-20'],
  }, async ({ page, pair }) => {
    await test.step('a machine paired without --personal', async () => {
      const machine = pair(urlOf(await addMachine(page)), {})
      expect(await machine.closed).toBe('This host was paired as your machine: restart spyria-host with --personal')
      await expect(machineSectionOf(page)).toContainText('Offline')
    })
    await test.step('a workspace host paired with --personal', async () => {
      const command = await addWorkspaceHost(page)
      expect(command).not.toContain('--personal')
      const host = pair(urlOf(command), { personal: true, signedIn: [] })
      expect(await host.closed).toBe('This host was paired as a workspace host: restart spyria-host without --personal')
      await expect(hostsSectionOf(page).getByRole('listitem').filter({ hasText: 'Workspace box' })).toContainText(
        'Offline',
      )
    })
  })
})
