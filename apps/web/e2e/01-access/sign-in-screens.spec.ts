import { type Browser, expect, test } from '../fixtures'

type AuthMode = {
  isBeingSetUp: boolean
  canCreateWorkspace: boolean
  accountProviders: string[]
  instanceApps: string[]
}
type Provider = { id: string; kind: string; isWorkspaceSso: boolean }

const signedOutPageOf = async (
  browser: Browser,
  {
    isBeingSetUp = false,
    canCreateWorkspace = false,
    accountProviders = ['oidc'],
    instanceApps = [],
  }: Partial<AuthMode>,
  providers: Provider[] = [],
) => {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  await page.route('**/auth/sessions', (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route('**/auth/mode**', (route) =>
    route.fulfill({
      json: { authMode: 'sso', isBeingSetUp, canCreateWorkspace, accountProviders, instanceApps },
    }),
  )
  await page.route('**/auth/providers**', (route) => route.fulfill({ json: { providers } }))
  await page.goto('/')
  return page
}

test.describe('Sign-in screens', () => {
  test('As a visitor, I see the sign-in card asking for my email', async ({ browser }) => {
    const page = await signedOutPageOf(browser, {})
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
    const form = page.getByRole('form', { name: 'Sign in' })
    await expect(form.getByRole('textbox', { name: 'Email' })).toBeVisible()
    await expect(form.getByRole('button', { name: 'Continue' })).toBeVisible()
  })

  test('As a visitor whose email several providers sign in, I choose one by name, or use another address', {
    tag: ['@spec-37'],
  }, async ({ browser }) => {
    const page = await signedOutPageOf(browser, {}, [
      { id: 'google', kind: 'google', isWorkspaceSso: false },
      { id: 'workspace-0', kind: 'oidc', isWorkspaceSso: true },
      { id: 'workspace-1', kind: 'google', isWorkspaceSso: true },
      { id: 'workspace-2', kind: 'microsoft', isWorkspaceSso: true },
    ])
    await page.getByRole('textbox', { name: 'Email' }).fill('pat@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('button', { name: /^Continue with/ })).toHaveText([
      'Continue with Google',
      "Continue with your organization's sign-in",
      "Continue with your organization's Google Workspace",
      "Continue with your organization's Microsoft Entra",
    ])
    await expect(page.getByText('pat@example.com', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Use another address' }).click()
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveValue('pat@example.com')
  })

  test('As a visitor whose email no provider signs in, I am told no workspace has invited it', {
    tag: ['@spec-37'],
  }, async ({ browser }) => {
    const page = await signedOutPageOf(browser, { accountProviders: [] })
    await page.getByRole('textbox', { name: 'Email' }).fill('pat@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('No workspace has invited pat@example.com')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  test('As a visitor reaching a fresh install without the setup link, I see that it is being set up and cannot create a workspace', {
    tag: ['@spec-53'],
  }, async ({ browser }) => {
    const page = await signedOutPageOf(browser, { isBeingSetUp: true })
    await expect(page.getByRole('heading', { name: 'This Spyria is being set up' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Create a workspace' })).toHaveCount(0)
    await expect(page.getByRole('form', { name: 'Sign in' })).toHaveCount(0)
  })

  test("As the first person on an empty Spyria, I create the workspace with an account of this Spyria or switch to my organization's provider", {
    tag: ['@spec-53'],
  }, async ({ browser }) => {
    const page = await signedOutPageOf(browser, {
      isBeingSetUp: true,
      canCreateWorkspace: true,
      accountProviders: ['google', 'microsoft'],
    })
    await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
    await expect(page.getByText('No workspace exists on this Spyria yet. You become its Admin.')).toBeVisible()
    const form = page.getByRole('form', { name: 'Create a workspace' })
    await expect(form.getByRole('textbox', { name: 'Workspace name' })).toBeVisible()
    await expect(form.getByRole('button', { name: /^Continue with/ })).toHaveText([
      'Continue with Google',
      'Continue with Microsoft',
    ])
    await expect(form.getByLabel('Provider')).toHaveCount(0)
    await form.getByRole('button', { name: "Use your organization's provider instead" }).click()
    await expect(form.getByLabel('Provider')).toBeVisible()
    await expect(form.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
    await form.getByRole('button', { name: 'Sign in with your own account instead' }).click()
    await expect(form.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  })

  test("As the first person on a Spyria without accounts of its own, I create the workspace with my organization's provider, through the Google app of this Spyria or my own app", {
    tag: ['@spec-53'],
  }, async ({ browser }) => {
    const page = await signedOutPageOf(browser, {
      isBeingSetUp: true,
      canCreateWorkspace: true,
      accountProviders: [],
      instanceApps: ['google'],
    })
    const form = page.getByRole('form', { name: 'Create a workspace' })
    await expect(form).toContainText("Your organization's provider becomes the only way into this workspace.")
    await expect(form.getByLabel('Provider')).toHaveValue('google')
    await expect(form).toContainText('Members sign in through the Google app of this Spyria')
    await expect(form.getByLabel('Client id')).toHaveCount(0)
    await expect(form.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    await expect(form.getByRole('button', { name: 'Sign in with your own account instead' })).toHaveCount(0)
    await form.getByRole('button', { name: 'Use your own app' }).click()
    await expect(form.getByLabel('Client id')).toBeVisible()
    await expect(form.getByLabel('Client secret')).toBeVisible()
    await expect(form.getByRole('button', { name: 'Create and sign in' })).toBeVisible()
  })
})
