import { expect, machineSectionOf, openProfile, type Page, hostTest as test, urlOf } from './fixtures'

test.describe('Host versions', () => {
  test.use({ runtimeHost: false, signedInAs: 'member-bob' })

  const addMachine = async (page: Page) => {
    await openProfile(page)
    await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add my machine' })
    const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
    await dialog.getByRole('button', { name: 'Close' }).click()
    return command
  }

  test('As a member whose machine runs an out-of-date spyria-host, I see Update needed with the update command on my machine, and my host is refused with that reason instead of not registered; after updating, it reconnects', {
    tag: ['@spec-53'],
  }, async ({ page, pair }) => {
    await page.goto('/')
    const command = await addMachine(page)
    const machine = machineSectionOf(page)
    await test.step('an out-of-date host is refused with the update command as the reason', async () => {
      const outdated = pair(urlOf(command), { personal: true, signedIn: [], outdated: true })
      expect(await outdated.closed).toMatch(/^This host is out of date: update it with docker /)
    })
    await test.step('my machine shows Update needed, and the command keeps its state volume and needs no code', async () => {
      await machine.getByRole('button', { name: 'Update needed' }).click()
      const dialog = page.getByRole('dialog', { name: 'Update needed' })
      await expect(dialog).toContainText('refused until it is updated')
      const updateCommand = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
      expect(updateCommand).toContain('docker rm -f spyria-test-e2e-host')
      expect(updateCommand).not.toContain('docker volume rm')
      expect(updateCommand).toMatch(/ spyria-test-e2e-host --personal https?:\/\/[^/]+$/)
      await dialog.getByRole('button', { name: 'Close' }).click()
    })
    await test.step('an updated host reconnects and the badge goes away', async () => {
      await machine.getByRole('button', { name: 'Start' }).click()
      const start = page.getByRole('dialog', { name: 'Start my machine' })
      await start.getByRole('button', { name: 'Set up again' }).click()
      const newCommand = await start.getByRole('textbox', { name: 'Command' }).inputValue()
      await start.getByRole('button', { name: 'Close' }).click()
      pair(urlOf(newCommand), { personal: true, signedIn: [] })
      await expect(machine).toContainText('Online')
      await expect(machine).toContainText('e2e')
      await expect(machine.getByRole('button', { name: /^Update / })).toHaveCount(0)
    })
  })
})
