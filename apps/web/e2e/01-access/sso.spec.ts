import { openPageAs, type WorkerStack } from '../stack'
import { e2eSetupToken } from '../stack-ports'
import {
  type Browser,
  creationFormOf,
  expect,
  invite,
  type Locator,
  logInAtProvider,
  mainOf,
  menuItemNamesOf,
  openMenu,
  openSettings,
  type Page,
  pendingInvitesOf,
  ssoProviderIssuer,
  ssoViteUrl,
  switcherOf,
  test,
} from './fixtures'

const providerClientId = 'spyria-sso'
const providerClientSecret = 'spyria-sso-e2e-secret'
const unreachableIssuer = 'http://localhost:9/nothing'
const discoveryFailure = /^The discovery of http:\/\/localhost:9\/nothing failed: check that the issuer is right/
const accountSignInLabel = 'Continue with single sign-on'
const organizationSignInLabel = "Continue with your organization's sign-in"
const notEnforcedText = 'Members sign in with their own account, through the sign-in of this Spyria.'
const enforcedText = "This workspace enforces SSO: only your organization's provider opens it"
const accountSignInRequired =
  "Your organization's sign-in opens only its workspace: sign in with your own account to do this"

const signInSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Sign-in' })
const providerFormOf = (page: Page) => signInSectionOf(page).getByRole('form', { name: 'SSO provider' })

const fillProvider = async (scope: Locator, issuer: string) => {
  await scope.getByLabel('Provider').selectOption('oidc')
  await scope.getByLabel('Issuer').fill(issuer)
  await scope.getByLabel('Client id').fill(providerClientId)
  await scope.getByLabel('Client secret').fill(providerClientSecret)
}

const signInThroughPopup = async (page: Page, open: () => Promise<void>, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await open()
  const popup = await popupOpened
  await expect(popup).toHaveURL(new RegExp(`^${ssoProviderIssuer}/`))
  await logInAtProvider(popup, email)
}

const continueWith = async (page: Page, email: string) => {
  await page.getByRole('form', { name: 'Sign in' }).getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
}

const signInStraightThroughProvider = (page: Page, email: string) =>
  signInThroughPopup(page, () => continueWith(page, email), email)

const signInThroughChosenProvider = async (page: Page, email: string, providerLabel: string) => {
  await continueWith(page, email)
  const choice = page.getByRole('button', { name: providerLabel })
  await expect(choice).toBeVisible()
  await signInThroughPopup(page, () => choice.click(), email)
}

const enforceAcmeSso = async (page: Page) => {
  await openSettings(page, 'Single sign-on')
  await fillProvider(providerFormOf(page), ssoProviderIssuer)
  await signInThroughPopup(
    page,
    () => providerFormOf(page).getByRole('button', { name: 'Enforce SSO' }).click(),
    'alice@example.com',
  )
  await expect(signInSectionOf(page)).toContainText(enforcedText)
}

const enforceAcmeSsoAsAlice = async (browser: Browser, workerStack: WorkerStack) => {
  const alicePage = await openPageAs(browser, workerStack, 'member-alice', ssoViteUrl)
  await enforceAcmeSso(alicePage)
  await alicePage.context().close()
}

const inviteToAcme = (workerStack: WorkerStack, email: string) =>
  workerStack.database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    values ('workspace-acme', ${crypto.randomUUID()}, ${email}, 'member', 'member-alice', now(), now() + interval '7 days')`

const ssoEventsOf = async (workerStack: WorkerStack, workspaceId: string) =>
  (
    await workerStack.database.$client`
      select type from workspace_events where workspace_id = ${workspaceId} and type like 'sso.%' order by created_at`
  ).map(({ type }) => type)

const acmeSsoRowsOf = (workerStack: WorkerStack) =>
  workerStack.database.$client`select issuer, client_id from workspace_sso where workspace_id = 'workspace-acme'`

test.describe('SSO', () => {
  test.use({ baseURL: ssoViteUrl, signedInAs: null, runtimeHost: false, warmRuntimes: false })

  test('As a visitor of an instance that has a workspace, I am offered no workspace creation, my email leads straight to the sign-in of this Spyria, and signed in without an invite I am offered to create a workspace', {
    tag: ['@spec-37', '@spec-51'],
  }, async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in to Spyria' })).toBeVisible()
    await expect(creationFormOf(page)).toHaveCount(0)
    await signInStraightThroughProvider(page, 'olive@example.com')
    await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
    await expect(page.getByText('You are signed in, but no workspace of yours opens with this account.')).toBeVisible()
    await expect(page.getByRole('button', { name: organizationSignInLabel })).toHaveCount(0)
    await expect(page.getByText(/Acme|Globex/)).toHaveCount(0)
  })

  test('As an invitee of a workspace enforcing SSO, I see its sign-in after typing my email and join through it, while a stranger goes straight to the sign-in of this Spyria', {
    tag: ['@spec-37'],
  }, async ({ page, browser, workerStack }) => {
    await enforceAcmeSsoAsAlice(browser, workerStack)
    await inviteToAcme(workerStack, 'nina@example.com')
    await page.goto('/')

    await test.step('my email offers this Spyria and the sign-in of my organization, and I can use another address', async () => {
      await continueWith(page, 'nina@example.com')
      await expect(page.getByText('nina@example.com', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: /^Continue with/ })).toHaveText([
        accountSignInLabel,
        organizationSignInLabel,
      ])
      await page.getByRole('button', { name: 'Use another address' }).click()
      await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible()
    })

    await test.step("signing in through my organization's sign-in opens the workspace that invited me", async () => {
      await signInThroughChosenProvider(page, 'nina@example.com', organizationSignInLabel)
      await expect(switcherOf(page)).toContainText('Acme')
      expect(await menuItemNamesOf(page)).toEqual(['New workspace', 'Acme', 'Log out of Acme'])
    })

    await test.step('a stranger is offered no choice: the popup goes straight to the sign-in of this Spyria', async () => {
      const olivePage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      const popupOpened = olivePage.waitForEvent('popup')
      await continueWith(olivePage, 'olive@example.com')
      const popup = await popupOpened
      await expect(popup).toHaveURL(new RegExp(`^${ssoProviderIssuer}/`))
      await expect(olivePage.getByRole('button', { name: organizationSignInLabel })).toHaveCount(0)
      await popup.close()
      await expect(olivePage.getByRole('button', { name: 'Continue' })).toBeEnabled()
      await olivePage.context().close()
    })
  })

  test("As a member of a workspace enforcing SSO, my own account does not open it and my organization's sign-in does", {
    tag: ['@spec-37'],
  }, async ({ page, browser, workerStack }) => {
    await enforceAcmeSsoAsAlice(browser, workerStack)
    await page.goto('/')

    await test.step('signing in with my own account opens no workspace and offers to create one', async () => {
      await signInThroughChosenProvider(page, 'bob@example.com', accountSignInLabel)
      await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
      await expect(page.getByText(/Acme/)).toHaveCount(0)
    })

    await test.step("signing in through my organization's sign-in opens Acme", async () => {
      await page.reload()
      await signInThroughChosenProvider(page, 'bob@example.com', organizationSignInLabel)
      await expect(switcherOf(page)).toContainText('Acme')
    })
  })

  test('As the first person installing Spyria, I need the setup link, then create the first workspace with my own account: it does not enforce SSO and the people I invite sign in with theirs', {
    tag: ['@spec-51', '@spec-53'],
  }, async ({ page, browser, workerStack }) => {
    await workerStack.database.$client`truncate workspaces cascade`

    await test.step('without the setup link, or with a wrong one, the instance is being set up', async () => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'This Spyria is being set up' })).toBeVisible()
      await expect(creationFormOf(page)).toHaveCount(0)
      await page.goto('/?setup=not-the-token')
      await expect(page.getByRole('heading', { name: 'This Spyria is being set up' })).toBeVisible()
    })

    await test.step('with the setup link, I name the workspace and sign in with my own account', async () => {
      await page.goto(`/?setup=${e2eSetupToken}`)
      await expect(page.getByRole('heading', { name: 'Create a workspace' })).toBeVisible()
      await expect(page.getByText('No workspace exists on this Spyria yet. You become its Admin.')).toBeVisible()
      await creationFormOf(page).getByLabel('Workspace name').fill('Umbrella')
      await signInThroughPopup(
        page,
        () => creationFormOf(page).getByRole('button', { name: accountSignInLabel }).click(),
        'alice@example.com',
      )
      await expect(switcherOf(page)).toContainText('Umbrella')
      await openSettings(page, 'Single sign-on')
      await expect(signInSectionOf(page)).toContainText(notEnforcedText)
      await expect(providerFormOf(page).getByRole('button', { name: 'Enforce SSO' })).toBeVisible()
      expect(await workerStack.database.$client`select 1 from workspace_sso`).toHaveLength(0)
    })

    await test.step('a person I invite signs in with their own account and lands in the workspace', async () => {
      await openSettings(page, 'Members and roles')
      await invite(page, 'bob@example.com')
      await expect(pendingInvitesOf(page)).toContainText('bob@example.com')
      const bobPage = await openPageAs(browser, workerStack, null, ssoViteUrl)
      await signInStraightThroughProvider(bobPage, 'bob@example.com')
      await expect(switcherOf(bobPage)).toContainText('Umbrella')
      await bobPage.context().close()
    })
  })

  test("As the first person installing Spyria, I create the first workspace with my organization's provider, which then enforces SSO; a provider whose discovery fails creates nothing", {
    tag: ['@spec-51', '@spec-53'],
  }, async ({ page, workerStack }) => {
    await workerStack.database.$client`truncate workspaces cascade`
    await page.goto(`/?setup=${e2eSetupToken}`)
    const form = creationFormOf(page)
    await form.getByLabel('Workspace name').fill('Umbrella')
    await form.getByRole('button', { name: "Use your organization's provider instead" }).click()
    await expect(form).toContainText("Your organization's provider becomes the only way into this workspace.")
    await expect(form.getByRole('button', { name: accountSignInLabel })).toHaveCount(0)

    await test.step('a provider whose discovery fails is refused with its reason and creates nothing', async () => {
      await fillProvider(form, unreachableIssuer)
      await form.getByRole('button', { name: 'Create and sign in' }).click()
      await expect(page.getByText(discoveryFailure)).toBeVisible()
      expect(await workerStack.database.$client`select 1 from workspaces`).toHaveLength(0)
    })

    await test.step('signing in through my provider creates the workspace, which enforces SSO without showing its secret', async () => {
      await form.getByLabel('Issuer').fill(ssoProviderIssuer)
      await signInThroughPopup(
        page,
        () => form.getByRole('button', { name: 'Create and sign in' }).click(),
        'alice@example.com',
      )
      await expect(switcherOf(page)).toContainText('Umbrella')
      await openSettings(page, 'Single sign-on')
      await expect(signInSectionOf(page)).toContainText(enforcedText)
      await expect(providerFormOf(page).getByLabel('Issuer')).toHaveValue(ssoProviderIssuer)
      await expect(providerFormOf(page).getByLabel('Client secret')).toHaveValue('')
      await expect(page.locator('body')).not.toContainText(providerClientSecret)
      expect(await workerStack.database.$client`select issuer, client_id as "clientId" from workspace_sso`).toEqual([
        { issuer: ssoProviderIssuer, clientId: providerClientId },
      ])
    })
  })

  test.describe(() => {
    test.use({ signedInAs: 'member-alice' })

    test('As an Admin, I enforce SSO in Single sign-on by signing in through the provider with my own address; another address, or a provider whose discovery fails, changes nothing', {
      tag: ['@spec-37'],
    }, async ({ page, workerStack }) => {
      await page.goto('/')
      await openSettings(page, 'Single sign-on')
      const form = providerFormOf(page)

      await test.step('the workspace does not enforce SSO: members sign in with their own account', async () => {
        await expect(signInSectionOf(page)).toContainText(notEnforcedText)
        await expect(form.getByRole('button', { name: 'Enforce SSO' })).toBeVisible()
        await expect(signInSectionOf(page).getByRole('button', { name: 'Stop enforcing SSO' })).toHaveCount(0)
      })

      await test.step('signing in to the provider as someone else is refused and changes nothing', async () => {
        await fillProvider(form, ssoProviderIssuer)
        await signInThroughPopup(
          page,
          () => form.getByRole('button', { name: 'Enforce SSO' }).click(),
          'bob@example.com',
        )
        await expect(
          form.getByText('Sign in as alice@example.com to confirm the provider: nothing was changed'),
        ).toBeVisible()
        await expect(signInSectionOf(page)).toContainText(notEnforcedText)
        expect(await acmeSsoRowsOf(workerStack)).toHaveLength(0)
      })

      await test.step('an issuer whose discovery fails is refused with its reason', async () => {
        await form.getByLabel('Issuer').fill(unreachableIssuer)
        await form.getByRole('button', { name: 'Enforce SSO' }).click()
        await expect(form.getByText(discoveryFailure)).toBeVisible()
        expect(await acmeSsoRowsOf(workerStack)).toHaveLength(0)
      })

      await test.step('signing in as myself enforces SSO, keeps me in the workspace and never shows the secret', async () => {
        await form.getByLabel('Issuer').fill(ssoProviderIssuer)
        await signInThroughPopup(
          page,
          () => form.getByRole('button', { name: 'Enforce SSO' }).click(),
          'alice@example.com',
        )
        await expect(signInSectionOf(page)).toContainText(enforcedText)
        await expect(form.getByRole('button', { name: 'Save and sign in again' })).toBeVisible()
        await expect(signInSectionOf(page).getByRole('button', { name: 'Stop enforcing SSO' })).toBeVisible()
        await expect(form.getByLabel('Provider')).toHaveValue('oidc')
        await expect(form.getByLabel('Client id')).toHaveValue(providerClientId)
        await expect(form.getByText('Secret: set')).toBeVisible()
        await expect(form.getByLabel('Client secret')).toHaveValue('')
        await expect(page.locator('body')).not.toContainText(providerClientSecret)
        await expect(switcherOf(page)).toContainText('Acme')
        expect(await ssoEventsOf(workerStack, 'workspace-acme')).toEqual(['sso.configured'])
      })
    })

    test("As an Admin of a workspace enforcing SSO, my organization's sign-in opens only that workspace and cannot create another, and stopping SSO signs everyone out of it until they sign in with their own account", {
      tag: ['@spec-37'],
    }, async ({ page, browser, workerStack }) => {
      await page.goto('/')
      await enforceAcmeSso(page)
      const throughOrganization = await openPageAs(browser, workerStack, null, ssoViteUrl)

      await test.step("signing in through my organization's sign-in lists only its workspace", async () => {
        await signInThroughChosenProvider(throughOrganization, 'alice@example.com', organizationSignInLabel)
        await expect(switcherOf(throughOrganization)).toContainText('Acme')
        expect(await menuItemNamesOf(throughOrganization)).toEqual(['New workspace', 'Acme', 'Log out of Acme'])
      })

      await test.step('creating a workspace from that session is refused and creates nothing', async () => {
        await openMenu(throughOrganization)
        await throughOrganization.getByRole('menuitem', { name: 'New workspace' }).click()
        const dialog = throughOrganization.getByRole('dialog', { name: 'New workspace' })
        await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('Side project')
        await dialog.getByRole('button', { name: 'Confirm' }).click()
        await expect(dialog).toContainText(accountSignInRequired)
        expect(await workerStack.database.$client`select 1 from workspaces where name = 'Side project'`).toHaveLength(0)
      })

      await test.step('stopping SSO asks to confirm, and Cancel keeps it enforced', async () => {
        await signInSectionOf(page).getByRole('button', { name: 'Stop enforcing SSO' }).click()
        const confirmation = page.getByRole('dialog', { name: 'Stop enforcing SSO' })
        await expect(confirmation).toContainText(
          'Everyone is signed out of this workspace, you included, and signs in again with their own account.',
        )
        await confirmation.getByRole('button', { name: 'Cancel' }).click()
        await expect(confirmation).toHaveCount(0)
        expect(await acmeSsoRowsOf(workerStack)).toHaveLength(1)
      })

      await test.step('stopping SSO signs everyone out of the workspace, me included', async () => {
        await signInSectionOf(page).getByRole('button', { name: 'Stop enforcing SSO' }).click()
        await page
          .getByRole('dialog', { name: 'Stop enforcing SSO' })
          .getByRole('button', { name: 'Stop enforcing', exact: true })
          .click()
        await expect(switcherOf(page)).toContainText('Globex')
        await openMenu(page)
        await expect(page.getByRole('menuitem', { name: /^Acme/ })).toContainText('Signed out')
        await page.keyboard.press('Escape')
        expect(await acmeSsoRowsOf(workerStack)).toHaveLength(0)
        expect(
          await workerStack.database.$client`select 1 from sessions where workspace_id = 'workspace-acme'`,
        ).toHaveLength(0)
        expect(await ssoEventsOf(workerStack, 'workspace-acme')).toEqual(['sso.configured', 'sso.removed'])
      })

      await test.step('a member then signs in with their own account, straight to the sign-in of this Spyria', async () => {
        const bobPage = await openPageAs(browser, workerStack, null, ssoViteUrl)
        await signInStraightThroughProvider(bobPage, 'bob@example.com')
        await expect(switcherOf(bobPage)).toContainText('Acme')
        await bobPage.context().close()
      })
      await throughOrganization.context().close()
    })
  })
})
