import { expect, mainOf, sidebarOf, test } from './fixtures'

test.describe('Appearance', () => {
  test.use({ runtimeHost: false, warmRuntimes: false })

  test('As a member, I switch the app to dark from my profile, it stays dark after a reload, and System follows my device again', {
    tag: ['@spec-05'],
  }, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
    const appearance = mainOf(page).getByRole('radiogroup', { name: 'Appearance' })
    const backgroundOfPage = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await expect(appearance.getByRole('radio', { name: 'System' })).toBeChecked()
    const lightBackground = await backgroundOfPage()

    await appearance.getByRole('radio', { name: 'Dark' }).check()
    await expect.poll(backgroundOfPage).not.toBe(lightBackground)
    const darkBackground = await backgroundOfPage()

    await page.reload()
    await expect(appearance.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(await backgroundOfPage()).toBe(darkBackground)

    await appearance.getByRole('radio', { name: 'System' }).check()
    await expect.poll(backgroundOfPage).toBe(lightBackground)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(backgroundOfPage).toBe(darkBackground)

    await appearance.getByRole('radio', { name: 'Light' }).check()
    await expect.poll(backgroundOfPage).toBe(lightBackground)
  })
})
