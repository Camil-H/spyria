import { openPageAs, type WorkerStack } from '../stack'
import {
  expect,
  logInAtProvider,
  mainOf,
  openSettings,
  type Page,
  serverUrl,
  ssoProviderIssuer,
  ssoServerUrl,
  ssoViteUrl,
  switcherOf,
  test,
} from './fixtures'

const providerClientSecret = 'spyria-sso-e2e-secret'
const acmeSso = {
  preset: 'oidc',
  issuer: ssoProviderIssuer,
  clientId: 'spyria-sso',
  clientSecret: providerClientSecret,
}

const postAsAlice = async (workerStack: WorkerStack, path: string, body: object) => {
  const tokenQuery = new URLSearchParams({
    db: workerStack.databaseName,
    user: 'member-alice',
    workspace: 'workspace-acme',
  })
  const { token } = await (await fetch(`${serverUrl}/test/token?${tokenQuery}`, { method: 'POST' })).json()
  const response = await fetch(`${ssoServerUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
}

const configureAcmeSso = (workerStack: WorkerStack, domains = ['example.com']) =>
  postAsAlice(workerStack, '/api/sso-settings', { ...acmeSso, domains })

const verificationAddressOf = (workerStack: WorkerStack, domain: string) => `it-${workerStack.databaseName}@${domain}`

const lastLinkTo = async (address: string) => {
  const mails: { to: string[]; text: string }[] = await (await fetch(`${ssoServerUrl}/test/mails`)).json()
  return mails.findLast((mail) => mail.to.includes(address))?.text.match(/https?:\/\/\S+/)?.[0] ?? ''
}

const verifyByLink = async (workerStack: WorkerStack, domain = 'example.com') => {
  const address = verificationAddressOf(workerStack, domain)
  await postAsAlice(workerStack, '/api/sso-settings/domain-verification', { domain, email: address })
  const testCookie = `spyria_test=${encodeURIComponent(JSON.stringify({ db: workerStack.databaseName }))}`
  const opened = await fetch(await lastLinkTo(address), { headers: { cookie: testCookie } })
  expect(opened.status).toBe(200)
}

const inviteToAcme = (workerStack: WorkerStack, email: string) =>
  workerStack.database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    values ('workspace-acme', ${crypto.randomUUID()}, ${email}, 'member', 'member-alice', now(), now() + interval '7 days')`

const continueWith = async (page: Page, email: string) => {
  await page.getByRole('textbox', { name: 'Work email' }).fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
}

const signInThroughCompanyProvider = async (page: Page, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await continueWith(page, email)
  const popup = await popupOpened
  await expect(popup).toHaveURL(new RegExp(`^${ssoProviderIssuer}/`))
  await logInAtProvider(popup, email)
}

const signInSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Sign-in' })

test.describe('SSO', () => {
  test.use({ baseURL: ssoViteUrl, signedInAs: null, runtimeHost: false, warmRuntimes: false })

  test.beforeEach(async ({ workerStack }) => {
    await configureAcmeSso(workerStack)
  })

  test('As a member of a company domain, I enter my work email and sign in through my company provider; without an invite I am told no workspace invited me', {
    tag: ['@spec-37'],
  }, async ({ page, browser, workerStack }) => {
    await verifyByLink(workerStack)
    await inviteToAcme(workerStack, 'nina@example.com')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
    await signInThroughCompanyProvider(page, 'nina@example.com')
    await expect(switcherOf(page)).toContainText('Acme')

    await test.step('a person of the domain without membership or invite reaches the provider, then is told no workspace invited them', async () => {
      const olivePage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await signInThroughCompanyProvider(olivePage, 'olive@example.com')
      await expect(olivePage.getByText('No workspace has invited olive@example.com')).toBeVisible()
      await olivePage.context().close()
    })
  })

  test('As a visitor, an email of a domain no workspace uses is refused without reaching any provider', {
    tag: ['@spec-37'],
  }, async ({ page }) => {
    const providerRequests: string[] = []
    page.context().on('request', (request) => {
      if (request.url().startsWith(ssoProviderIssuer)) providerRequests.push(request.url())
    })
    await page.goto('/')
    await continueWith(page, 'pat@other.com')
    await expect(page.getByText('No workspace signs in with other.com')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(providerRequests).toEqual([])
  })

  test.describe(() => {
    test.use({ signedInAs: 'member-alice' })

    test('As a member who can set up SSO, I see the provider without its secret, replace the secret and sign-in keeps working, and a failing discovery is refused', {
      tag: ['@spec-37'],
    }, async ({ page, browser, workerStack }) => {
      await verifyByLink(workerStack)
      await page.goto('/')
      await openSettings(page, 'Setup SSO')
      const section = signInSectionOf(page)
      const secretField = section.getByLabel('Client secret')

      await test.step('the section shows the provider, client id, domains and "Secret: set", never the secret', async () => {
        await expect(section.getByLabel('Provider')).toHaveValue('oidc')
        await expect(section.getByLabel('Issuer')).toHaveValue(ssoProviderIssuer)
        await expect(section.getByLabel('Client id')).toHaveValue('spyria-sso')
        await expect(section.getByLabel('Email domains')).toHaveValue('example.com')
        await expect(section.getByText('Secret: set')).toBeVisible()
        await expect(secretField).toHaveValue('')
        await expect(page.locator('body')).not.toContainText(providerClientSecret)
      })

      await test.step('replacing the secret saves it and sign-in keeps working', async () => {
        await secretField.fill(providerClientSecret)
        await section.getByRole('button', { name: 'Save' }).click()
        await expect(section.getByText('Saved')).toBeVisible()
        await expect(secretField).toHaveValue('')
        const events = await workerStack.database.$client`
          select type from workspace_events where workspace_id = 'workspace-acme' and type like 'sso.%' order by created_at`
        expect(events.map(({ type }) => type)).toEqual(['sso.configured', 'sso.domain_verified', 'sso.secret_rotated'])
        await inviteToAcme(workerStack, 'nina@example.com')
        const ninaPage = await openPageAs(browser, workerStack, null, ssoViteUrl)
        await signInThroughCompanyProvider(ninaPage, 'nina@example.com')
        await expect(switcherOf(ninaPage)).toContainText('Acme')
        await ninaPage.context().close()
      })

      await test.step('an issuer whose discovery fails is refused with its reason', async () => {
        await section.getByLabel('Issuer').fill('http://localhost:9/nothing')
        await section.getByRole('button', { name: 'Save' }).click()
        await expect(section.getByText(/^The discovery of http:\/\/localhost:9\/nothing failed: .+/)).toBeVisible()
        const [stored] = await workerStack.database.$client`
          select issuer from workspace_sso where workspace_id = 'workspace-acme'`
        expect(stored?.issuer).toBe(ssoProviderIssuer)
      })
    })

    test('As a member who can set up SSO, I add a domain and verify it through the emailed link', {
      tag: ['@spec-37'],
    }, async ({ page, workerStack }) => {
      await configureAcmeSso(workerStack, ['example.net'])
      await page.goto('/')
      await openSettings(page, 'Setup SSO')
      const section = signInSectionOf(page)
      await section.getByLabel('Email domains').fill('example.net, example.com')
      await section.getByRole('button', { name: 'Save' }).click()
      await expect(section.getByText('Saved')).toBeVisible()
      const domainRow = section
        .getByRole('list', { name: 'Domains' })
        .getByRole('listitem')
        .filter({ hasText: 'example.com' })
      await expect(domainRow.getByText('Not verified', { exact: true })).toBeVisible()
      const address = verificationAddressOf(workerStack, 'example.com')

      await test.step('Send link mails a link to the address and shows the domain pending', async () => {
        await domainRow.getByLabel('Address at example.com').fill(address)
        await domainRow.getByRole('button', { name: 'Send link' }).click()
        await expect(domainRow.getByText(`Pending: sent to ${address}, expires `)).toBeVisible()
        await expect(domainRow.getByRole('button', { name: 'Resend' })).toBeVisible()
      })

      await test.step('opening the link verifies the domain, and Settings show it Verified', async () => {
        const linkPage = await page.context().newPage()
        await linkPage.goto(await lastLinkTo(address))
        await expect(
          linkPage.getByText('example.com is verified: people with an example.com email can now sign in'),
        ).toBeVisible()
        await linkPage.close()
        await page.reload()
        await expect(domainRow.getByText('Verified', { exact: true })).toBeVisible()
        await expect(domainRow.getByRole('button')).toHaveCount(0)
      })
    })
  })
})
