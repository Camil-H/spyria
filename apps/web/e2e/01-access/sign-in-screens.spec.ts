import { type Browser, expect, test } from '../fixtures'

const signedOutPageOf = async (browser: Browser, canCreateWorkspace: boolean) => {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.route('**/auth/sessions', (route) => route.fulfill({ json: { sessions: [], deployment: 'test' } }))
  await page.route('**/auth/mode', (route) => route.fulfill({ json: { authMode: 'sso', canCreateWorkspace } }))
  await page.goto('/')
  return page
}

test.describe('Sign-in screens', () => {
  test('As a visitor, I see the sign-in card', async ({ browser }) => {
    const page = await signedOutPageOf(browser, false)
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
  })

  test('As the first person on an empty Spyria, I see the create-workspace card without the Admin rule', async ({
    browser,
  }) => {
    const page = await signedOutPageOf(browser, true)
    await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
    await expect(page.getByText('No workspace exists on this Spyria yet.')).toBeVisible()
    await expect(page.getByText(/becomes the Admin/)).toHaveCount(0)
  })
})
