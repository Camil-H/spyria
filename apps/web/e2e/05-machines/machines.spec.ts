import { expect, openProfile, type Page } from '../fixtures'
import { hostsSectionOf, hostTest, machineSectionOf, machineToolOf, openSettings, urlOf } from './fixtures'

hostTest.describe('Machines', () => {
  hostTest.use({ runtimeHost: false })

  hostTest.describe(() => {
    hostTest.use({ signedInAs: 'member-bob' })

    hostTest(
      'As a member, I see my connected tool in green and the Use buttons below my machine and its Remove',
      async ({ page, pair }) => {
        await page.goto('/')
        await openProfile(page)
        await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
        const dialog = page.getByRole('dialog', { name: 'Add my machine' })
        const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
        await dialog.getByRole('button', { name: 'Close' }).click()
        pair(urlOf(command), { personal: true, signedIn: ['codex'] })
        const codexState = machineToolOf(page, 'Codex')
        await expect(codexState).toHaveText('✓ Codex connected')
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
      },
    )
  })

  const hostRowOf = (page: Page, hostName: string) =>
    hostsSectionOf(page).getByRole('listitem').filter({ hasText: hostName })
  const addDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Add runtime host' })
  const commandOf = (page: Page) => addDialogOf(page).getByRole('textbox', { name: 'Command' })
  const addHost = async (page: Page, hostName: string) => {
    await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
    await addDialogOf(page).getByRole('textbox', { name: 'Host name' }).fill(hostName)
    await addDialogOf(page).getByRole('button', { name: 'Add' }).click()
    const command = await commandOf(page).inputValue()
    await addDialogOf(page).getByRole('button', { name: 'Close' }).click()
    return urlOf(command)
  }
  const expectOnline = async (page: Page, hostName: string) => {
    await expect(hostRowOf(page, hostName)).toContainText('Online', { timeout: 10_000 })
  }

  hostTest.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  hostTest(
    'As a member who can manage runtime hosts, I copy a new host’s command and the button reads ✓ Copied',
    async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await openSettings(page, 'Connect runtime')
      await hostsSectionOf(page).getByRole('button', { name: 'Add runtime host' }).click()
      await addDialogOf(page).getByRole('textbox', { name: 'Host name' }).fill('Home server')
      await addDialogOf(page).getByRole('button', { name: 'Add' }).click()
      const command = await commandOf(page).inputValue()
      await addDialogOf(page).getByRole('button', { name: 'Copy' }).click()
      await expect(addDialogOf(page).getByRole('button', { name: '✓ Copied' })).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command)
    },
  )

  hostTest(
    'As a member who can manage runtime hosts, I see Docker: root or Docker: rootless badges with a tooltip, and limits that are not enforced',
    {
      tag: ['@spec-07', '@spec-25', '@stage-f'],
    },
    async ({ page, hosts }) => {
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
    },
  )
})
