import { expect, mainOf, openSettings, type Page, test } from '../fixtures'

const browserSettingsOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Browser' })
const switchOf = (page: Page, name: string) => browserSettingsOf(page).getByRole('switch', { name, exact: true })

test.describe('Browser settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member who can manage the tools, I turn members’ browsing off, block a site and limit sign-ins, an address that is not one is refused, and the change is kept', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    await openSettings(page, 'Browser')
    await expect(switchOf(page, 'Block internal networks')).toHaveAttribute('aria-checked', 'true')
    await expect(switchOf(page, 'Ask before the agent submits')).toHaveAttribute('aria-checked', 'true')
    await switchOf(page, 'Members browse').click()
    const blocked = browserSettingsOf(page).getByRole('textbox', { name: 'Sites blocked' })
    await blocked.fill('https://ads.example.com/\nnot a site')
    await browserSettingsOf(page).getByRole('spinbutton', { name: 'Sign-ins last at most, in hours' }).fill('8')
    await browserSettingsOf(page).getByRole('button', { name: 'Save' }).click()
    await expect(browserSettingsOf(page)).toContainText('not a site is not a host name or an IP address')

    await blocked.fill('https://ads.example.com/')
    await browserSettingsOf(page).getByRole('button', { name: 'Save' }).click()
    await expect(browserSettingsOf(page)).toContainText('Saved')
    await page.reload()
    await expect(switchOf(page, 'Members browse')).toHaveAttribute('aria-checked', 'false')
    await expect(blocked).toHaveValue('ads.example.com')
    await expect(
      browserSettingsOf(page).getByRole('spinbutton', { name: 'Sign-ins last at most, in hours' }),
    ).toHaveValue('8')
  })
})
