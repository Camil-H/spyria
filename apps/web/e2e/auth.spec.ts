import {
  composerOf,
  expect,
  logOutOf,
  menuItemNamesOf,
  messageItemsOf,
  openMenu,
  type Page,
  serverUrl,
  sidebarOf,
  switcherOf,
  test,
} from './fixtures'

const signInButtonOf = (page: Page) => page.getByRole('button', { name: 'Sign in' })

const signInThroughDex = async (page: Page, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  const popup = await popupOpened
  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#login').fill(email)
  await popup.locator('#password').fill('password')
  await popup.locator('#submit-login').click()
  await popupClosed
}

const alicesWorkspacesSignedIn = [
  'New workspace',
  'Acme',
  'Log out of Acme',
  'Globex',
  'Log out of Globex',
  'Workspace settings',
]

test.use({ signedInAs: null })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. first visit shows the sign-in screen and nothing from any workspace', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Sign in to HQ' })).toBeVisible()
  await expect(signInButtonOf(page)).toBeEnabled()
  await expect(sidebarOf(page)).toHaveCount(0)
  await expect(page.getByText(/Acme|Globex/)).toHaveCount(0)
})

test('2. signing in through the Dex popup opens Acme with both workspaces signed in', async ({ page }) => {
  await signInThroughDex(page, 'alice@example.com')
  await expect(switcherOf(page)).toContainText('Acme')
  await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
  expect(await menuItemNamesOf(page)).toEqual(alicesWorkspacesSignedIn)
})

test('3. closing the popup leaves the sign-in screen usable and without error', async ({ page }) => {
  const popupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  const popup = await popupOpened
  await expect(popup.locator('#login')).toBeVisible()
  await popup.close()

  await expect(signInButtonOf(page)).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Sign in to HQ' })).toBeVisible()
  await expect(page.getByText(/invited|error|failed/i)).toHaveCount(0)
  const secondPopupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  await (await secondPopupOpened).close()
})

test('4. a user without any membership is told no workspace invited them', async ({ page }) => {
  await signInThroughDex(page, 'nina@example.com')
  await expect(page.getByText('No workspace has invited nina@example.com')).toBeVisible()
  await expect(sidebarOf(page)).toHaveCount(0)
  await expect(page.getByText(/Acme|Globex/)).toHaveCount(0)
})

test('5. Bob sees only Acme and has no access to a Globex route', async ({ page }) => {
  await signInThroughDex(page, 'bob@example.com')
  await expect(switcherOf(page)).toContainText('Acme')
  expect(await menuItemNamesOf(page)).toEqual(['New workspace', 'Acme', 'Log out of Acme'])

  await page.goto('/w/workspace-globex/chats/chat-launch-plan')
  await expect(page.getByText("You don't have access to this workspace")).toBeVisible()
  await expect(sidebarOf(page)).toHaveCount(0)
  await expect(page.getByText(/Globex|Launch plan/)).toHaveCount(0)
})

test('6. a reload restores the sessions without a popup', async ({ page }) => {
  await signInThroughDex(page, 'alice@example.com')
  await expect(sidebarOf(page)).toBeVisible()
  let popupCount = 0
  page.on('popup', () => popupCount++)

  await page.reload()
  await expect(switcherOf(page)).toContainText('Acme')
  await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
  expect(await menuItemNamesOf(page)).toEqual(alicesWorkspacesSignedIn)
  expect(popupCount).toBe(0)
})

test('7. logging out revokes the session: a reload keeps Acme signed out and its old token is refused', async ({
  page,
}) => {
  const sessionsLoaded = page.waitForResponse(
    async (response) => response.url().endsWith('/auth/sessions') && (await response.json()).sessions.length > 0,
  )
  await signInThroughDex(page, 'alice@example.com')
  const { sessions } = (await (await sessionsLoaded).json()) as {
    sessions: { workspaceId: string; token: string }[]
  }
  const acmeToken = sessions.find((session) => session.workspaceId === 'workspace-acme')?.token
  const queryWithAcmeToken = () =>
    fetch(`${serverUrl}/api/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${acmeToken}` },
      body: JSON.stringify(['transform', []]),
    })
  expect((await queryWithAcmeToken()).status).toBe(200)

  await logOutOf(page, 'Acme')
  await expect(page.getByText('You are signed out of Acme')).toBeVisible()
  await page.reload()
  await expect(page.getByText('You are signed out of Acme')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Go to Globex' })).toBeVisible()
  expect((await queryWithAcmeToken()).status).toBe(401)
})

test('8. signing in again from the signed-out screen restores Acme with its route and draft', async ({ page }) => {
  await signInThroughDex(page, 'alice@example.com')
  await sidebarOf(page).getByRole('link', { name: 'Welcome' }).click()
  await composerOf(page).fill('Draft before logout')
  const urlBeforeLogout = page.url()

  await logOutOf(page, 'Acme')
  await expect(page.getByText('You are signed out of Acme')).toBeVisible()
  await signInThroughDex(page, 'alice@example.com')

  expect(page.url()).toBe(urlBeforeLogout)
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(composerOf(page)).toHaveValue('Draft before logout')
  expect(await menuItemNamesOf(page)).toEqual(alicesWorkspacesSignedIn)
})

test.describe('signed in through the test hook', () => {
  test.use({ signedInAs: 'member-alice' })

  test.describe('with short-lived tokens', () => {
    test.use({ tokenSeconds: 3 })

    test('9. the app renews its token and keeps saving messages past expiry', async ({ page, workerStack }) => {
      let renewals = 0
      page.on('response', (response) => {
        if (response.url().endsWith('/auth/renew') && response.ok()) renewals++
      })
      await sidebarOf(page).getByRole('link', { name: 'Welcome' }).click()
      const { sessions } = await (await page.request.get('/auth/sessions')).json()
      const probeToken = sessions.find(
        (session: { workspaceId: string }) => session.workspaceId === 'workspace-acme',
      ).token
      const queryStatusWith = async (token: string) =>
        (
          await fetch(`${serverUrl}/api/query`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(['transform', []]),
          })
        ).status
      expect(await queryStatusWith(probeToken)).toBe(200)
      await expect.poll(() => queryStatusWith(probeToken), { timeout: 15_000 }).toBe(401)
      expect(renewals).toBeGreaterThan(0)

      await composerOf(page).fill('Sent after the first token expired')
      await composerOf(page).press('ControlOrMeta+Enter')
      await expect(messageItemsOf(page).last()).toContainText('Sent after the first token expired')
      await expect
        .poll(async () =>
          (await workerStack.database.query.messages.findMany({ where: { chatId: 'chat-welcome' } })).map(
            (message) => message.body,
          ),
        )
        .toContain('Sent after the first token expired')
    })

    test('10. logging out in another tab signs the first tab out of Acme at its next renewal', async ({
      page,
      context,
    }) => {
      await expect(sidebarOf(page)).toBeVisible()

      const secondTab = await context.newPage()
      await secondTab.goto('/')
      await expect(switcherOf(secondTab)).toContainText('Acme')
      await logOutOf(secondTab, 'Acme')
      await expect(secondTab.getByText('You are signed out of Acme')).toBeVisible()

      await expect(page.getByText('You are signed out of Acme')).toBeVisible({ timeout: 10_000 })
      await page.getByRole('link', { name: 'Go to Globex' }).click()
      await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
    })
  })

  test('11. a new workspace is signed in at once and stays signed in after a reload', async ({ page }) => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'New workspace' }).click()
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('Initech')
    const sessionOpened = page.waitForResponse(
      (response) => response.url().endsWith('/auth/sessions') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(switcherOf(page)).toContainText('Initech')
    await expect(sidebarOf(page)).toBeVisible()
    expect((await sessionOpened).status()).toBe(200)

    await page.reload()
    await expect(switcherOf(page)).toContainText('Initech')
    await expect(sidebarOf(page).getByRole('group')).toHaveCount(1)
    await expect(page.getByText(/You are signed out/)).toHaveCount(0)
  })
})
