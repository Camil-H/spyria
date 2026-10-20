import { openPageAs, type WorkerStack } from '../stack'
import {
  expect,
  invite,
  logInAtProvider,
  mainOf,
  menuItemNamesOf,
  openMenu,
  openSettings,
  type Page,
  pendingInvitesOf,
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

const creationFormOf = (page: Page) => page.getByRole('form', { name: 'Create a workspace' })

const fillCreationForm = async (page: Page, issuer: string) => {
  const form = creationFormOf(page)
  await form.getByLabel('Organization name').fill('Umbrella')
  await form.getByLabel('Email domain').fill('example.com')
  await form.getByLabel('Provider').selectOption('oidc')
  await form.getByLabel('Issuer').fill(issuer)
  await form.getByLabel('Client id').fill(acmeSso.clientId)
  await form.getByLabel('Client secret').fill(providerClientSecret)
}

const createWorkspaceThroughProvider = async (page: Page, email: string) => {
  await fillCreationForm(page, ssoProviderIssuer)
  const popupOpened = page.waitForEvent('popup')
  await creationFormOf(page).getByRole('button', { name: 'Create and sign in' }).click()
  const popup = await popupOpened
  await expect(popup).toHaveURL(new RegExp(`^${ssoProviderIssuer}/`))
  await logInAtProvider(popup, email)
}

test.describe('SSO', () => {
  test.use({ baseURL: ssoViteUrl, signedInAs: null, runtimeHost: false, warmRuntimes: false })

  test.beforeEach(async ({ workerStack }) => {
    await configureAcmeSso(workerStack)
  })

  test('As a member of a company domain, I enter my work email and sign in through my company provider, and a new workspace I create reuses my verified domain and provider; without an invite I am told no workspace invited me', {
    tag: ['@spec-37'],
  }, async ({ page, browser, workerStack }) => {
    await verifyByLink(workerStack)
    await inviteToAcme(workerStack, 'nina@example.com')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
    await signInThroughCompanyProvider(page, 'nina@example.com')
    await expect(switcherOf(page)).toContainText('Acme')

    await test.step('a new workspace I create reuses my verified domain and provider: one sign-in through it opens both', async () => {
      await openMenu(page)
      await page.getByRole('menuitem', { name: 'New workspace' }).click()
      await page.getByRole('textbox', { name: 'Workspace name' }).fill('Nina lab')
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(switcherOf(page)).toContainText('Nina lab')
      const copiedSignIn = async () =>
        (
          await workerStack.database.$client`
            select issuer, client_id as "clientId", domain, verified_at is not null as "isVerified"
            from workspace_sso join sso_domains using (workspace_id) join workspaces using (workspace_id)
            where workspaces.name = 'Nina lab'`
        )[0]
      await expect
        .poll(copiedSignIn)
        .toEqual({ issuer: ssoProviderIssuer, clientId: acmeSso.clientId, domain: 'example.com', isVerified: true })
      const ninaAgain = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await signInThroughCompanyProvider(ninaAgain, 'nina@example.com')
      expect(await menuItemNamesOf(ninaAgain)).toEqual([
        'New workspace',
        'Acme',
        'Log out of Acme',
        'Nina lab',
        'Log out of Nina lab',
      ])
      await ninaAgain.context().close()
    })

    await test.step('a person of the domain without membership or invite reaches the provider, then is told no workspace invited them', async () => {
      const olivePage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await signInThroughCompanyProvider(olivePage, 'olive@example.com')
      await expect(olivePage.getByText('No workspace has invited olive@example.com')).toBeVisible()
      await olivePage.context().close()
    })
  })

  test('As a visitor of an instance that has a workspace, I am offered no workspace creation, and an email of a domain no workspace uses is refused without reaching any provider', {
    tag: ['@spec-37', '@spec-51'],
  }, async ({ page }) => {
    const providerRequests: string[] = []
    page.context().on('request', (request) => {
      if (request.url().startsWith(ssoProviderIssuer)) providerRequests.push(request.url())
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Create a workspace' })).toHaveCount(0)
    await continueWith(page, 'pat@other.com')
    await expect(page.getByText('No workspace signs in with other.com')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(providerRequests).toEqual([])
  })

  test('As the first person of an organization on an empty instance, I create a workspace through my provider and land as its Admin; until the domain is verified through the emailed link nobody else is routed and inviting is refused, then invites work and Bob signs in through routing', {
    tag: ['@spec-51'],
  }, async ({ page, browser, workerStack }) => {
    await workerStack.database.$client`truncate workspaces cascade`
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
    await fillCreationForm(page, 'http://localhost:9/nothing')
    await creationFormOf(page).getByRole('button', { name: 'Create and sign in' }).click()
    await expect(page.getByText(/^The discovery of http:\/\/localhost:9\/nothing failed: .+/)).toBeVisible()
    expect(await workerStack.database.$client`select 1 from workspaces`).toHaveLength(0)
    await createWorkspaceThroughProvider(page, 'alice@example.com')
    await expect(switcherOf(page)).toContainText('Umbrella')
    await openSettings(page, 'Setup SSO')
    const domainRow = signInSectionOf(page)
      .getByRole('list', { name: 'Domains' })
      .getByRole('listitem')
      .filter({ hasText: 'example.com' })
    await expect(domainRow.getByText('Not verified', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText(providerClientSecret)

    await test.step('before verification, inviting is refused with its reason and nobody else is routed to the workspace', async () => {
      await openSettings(page, 'Manage Team')
      await invite(page, 'bob@example.com')
      await expect(
        mainOf(page).getByText(
          'Invites open once an email domain of this workspace is verified: send the verification link from the Sign-in settings',
        ),
      ).toBeVisible()
      await expect(pendingInvitesOf(page)).toHaveCount(0)
      const ninaPage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await continueWith(ninaPage, 'nina@example.com')
      await expect(ninaPage.getByText('No workspace signs in with example.com')).toBeVisible()
      await ninaPage.context().close()
    })

    await test.step('Send link mails a link to the address and shows the domain pending', async () => {
      await openSettings(page, 'Setup SSO')
      const address = verificationAddressOf(workerStack, 'example.com')
      await domainRow.getByLabel('Address at example.com').fill(address)
      await domainRow.getByRole('button', { name: 'Send link' }).click()
      await expect(domainRow.getByText(`Pending: sent to ${address}, expires `)).toBeVisible()
      await expect(domainRow.getByRole('button', { name: 'Resend' })).toBeVisible()
    })

    await test.step('opening the link verifies the domain, and Settings show it Verified', async () => {
      const linkPage = await page.context().newPage()
      await linkPage.goto(await lastLinkTo(verificationAddressOf(workerStack, 'example.com')))
      await expect(
        linkPage.getByText('example.com is verified: people with an example.com email can now sign in'),
      ).toBeVisible()
      await linkPage.close()
      await page.reload()
      await expect(domainRow.getByText('Verified', { exact: true })).toBeVisible()
      await expect(domainRow.getByRole('button')).toHaveCount(0)
    })

    await test.step('after verification, an invite works and Bob signs in through routing', async () => {
      await openSettings(page, 'Manage Team')
      await invite(page, 'bob@example.com')
      await expect(pendingInvitesOf(page)).toContainText('bob@example.com')
      const bobPage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await signInThroughCompanyProvider(bobPage, 'bob@example.com')
      await expect(switcherOf(bobPage)).toContainText('Umbrella')
      await bobPage.context().close()
    })
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
  })
})
