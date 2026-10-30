import { openPageAs } from '../stack'
import { expect, mainOf, openSettings, test } from './fixtures'

test.describe('Dev loop settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I turn the dev loop on and set its limits, which stay after a reload; a member who cannot connect GitHub is refused the page', {
    tag: ['@spec-57'],
  }, async ({ page, browser, workerStack }) => {
    await openSettings(page, 'Dev loop')
    const section = mainOf(page).getByRole('region', { name: 'Dev loop' })
    const loopSwitch = section.getByRole('switch', { name: 'Agents in dev chats check their own work' })
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(section.getByLabel('Times the agent fixes failing checks')).toHaveCount(0)
    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByLabel('Times the agent fixes failing checks')).toHaveValue('3')
    await section.getByLabel('Times the agent fixes failing checks').fill('5')
    await section.getByLabel('Times the agent fixes review findings (0 turns the review off)').fill('0')
    await section.getByLabel('Cost limit of a loop, in dollars (sessions on an API key only)').fill('2.5')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(section.getByLabel('Times the agent fixes failing checks')).toHaveValue('5')
    await expect(section.getByLabel('Times the agent fixes review findings (0 turns the review off)')).toHaveValue('0')
    await expect(section.getByLabel('Times the agent fixes failing CI (0 does not wait for CI)')).toHaveValue('2')
    await expect(section.getByLabel('Cost limit of a loop, in dollars (sessions on an API key only)')).toHaveValue(
      '2.5',
    )
    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(section.getByLabel('Times the agent fixes failing checks')).toHaveCount(0)

    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await leePage.goto('/w/workspace-acme/settings/dev-loop')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'Dev loop' })).toHaveCount(0)
    await leePage.context().close()
  })
})
