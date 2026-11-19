import {
  expect,
  logInAtProvider,
  mainOf,
  openSettings,
  type Page,
  ssoProviderIssuer,
  ssoViteUrl,
  test,
} from '../01-access/fixtures'
import type { WorkerStack } from '../stack'

const enforcedText = "This workspace enforces SSO: only your organization's provider opens it"
const notEnforcedText = 'Members sign in with their own account, through the sign-in of this Spyria.'

const signInSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Sign-in' })
const providerFormOf = (page: Page) => signInSectionOf(page).getByRole('form', { name: 'SSO provider' })
const warningOf = (page: Page) => page.getByRole('dialog', { name: 'Addresses at other domains' })

const bindAliceAccountAtProvider = (workerStack: WorkerStack) =>
  workerStack.database.$client`
    insert into account_identities (issuer, subject, user_id) values (${ssoProviderIssuer}, 'alice-account', 'member-alice')`

const inviteToAcme = (workerStack: WorkerStack, email: string) =>
  workerStack.database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    values ('workspace-acme', ${crypto.randomUUID()}, ${email}, 'member', 'member-alice', now(), now() + interval '7 days')`

test.describe('Single sign-on', () => {
  test.use({ baseURL: ssoViteUrl, signedInAs: 'member-alice', runtimeHost: false, warmRuntimes: false })

  test('As an Admin signed in with an account, I enforce SSO in one click from the provider suggested by my account, confirming through it', {
    tag: ['@spec-37', '@spec-55'],
  }, async ({ page, workerStack }) => {
    await bindAliceAccountAtProvider(workerStack)
    await page.goto('/')
    await openSettings(page, 'Single sign-on')
    const form = providerFormOf(page)
    await expect(form).toContainText(`Enforce ${new URL(ssoProviderIssuer).host} for this workspace`)
    await expect(form.getByLabel('Client id')).toHaveCount(0)

    const popupOpened = page.waitForEvent('popup')
    await form.getByRole('button', { name: 'Enforce SSO' }).click()
    await logInAtProvider(await popupOpened, 'alice@example.com')

    await expect(signInSectionOf(page)).toContainText('SSO enforced')
    await expect(signInSectionOf(page)).toContainText(enforcedText)
    await expect(form.getByRole('button', { name: 'Save and sign in again' })).toBeVisible()
  })

  test('As an Admin, choosing another provider with my own app, I see the redirect URI of this Spyria and copy it', {
    tag: ['@spec-37', '@spec-55'],
  }, async ({ page, workerStack }) => {
    await bindAliceAccountAtProvider(workerStack)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    await openSettings(page, 'Single sign-on')
    const form = providerFormOf(page)
    await form.getByRole('button', { name: 'Use another provider' }).click()
    await form.getByLabel('Provider').selectOption('microsoft')

    const redirectUri = `${new URL(ssoViteUrl).origin}/auth/callback`
    await expect(form.getByText(redirectUri, { exact: true })).toBeVisible()
    await expect(form).toContainText('an app registration for accounts in this organizational directory only')
    await form.getByRole('button', { name: 'Copy the redirect URI' }).click()
    await expect(form.getByRole('button', { name: 'Copy the redirect URI' })).toHaveText('✓ Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(redirectUri)
  })

  test('As an Admin with an invitee at another domain, I see that address before enforcing SSO, and Cancel changes nothing', {
    tag: ['@spec-37', '@spec-55'],
  }, async ({ page, workerStack }) => {
    await bindAliceAccountAtProvider(workerStack)
    await inviteToAcme(workerStack, 'pat@globex.test')
    await page.goto('/')
    await openSettings(page, 'Single sign-on')

    let popups = 0
    page.on('popup', () => popups++)
    await providerFormOf(page).getByRole('button', { name: 'Enforce SSO' }).click()
    const warning = warningOf(page)
    await expect(warning).toContainText('These addresses are at another domain than yours.')
    await expect(warning.getByRole('list', { name: 'Addresses at other domains' })).toHaveText('pat@globex.test')
    await expect(warning).not.toContainText('bob@example.com')
    await warning.getByRole('button', { name: 'Cancel' }).click()

    await expect(warning).toHaveCount(0)
    await expect(signInSectionOf(page)).toContainText(notEnforcedText)
    expect(popups).toBe(0)
    expect(
      await workerStack.database.$client`select 1 from workspace_sso where workspace_id = 'workspace-acme'`,
    ).toHaveLength(0)
  })
})
