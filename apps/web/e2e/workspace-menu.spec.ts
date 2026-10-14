import {
  composerOf,
  expect,
  logOutOf,
  mainOf,
  menuItemNamesOf,
  messageItemsOf,
  openMenu,
  type Page,
  sidebarOf,
  signedOutScreenOf,
  switcherOf,
  switchWorkspace,
  test,
} from './fixtures'

const logoutDialogOf = (page: Page, workspaceName: string) =>
  page.getByRole('dialog', { name: `Log out of ${workspaceName}` })
const anySignedOutScreenOf = (page: Page) => page.getByText(/You are signed out of/)

const navigateClientSide = (page: Page, path: string) =>
  page.evaluate((targetPath) => {
    window.history.pushState(null, '', targetPath)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('opens the menu and its dialogs, then logs out of Acme', async ({ page }) => {
  await test.step('has no log-out icon while the menu is closed and closes with Escape', async () => {
    await expect(page.getByRole('menuitem', { name: /Log out of/ })).toHaveCount(0)
    await openMenu(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: /Log out of/ })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'New workspace' })).toHaveCount(0)
  })

  await test.step('lists New workspace first, then each workspace with its log-out icon', async () => {
    expect(await menuItemNamesOf(page)).toEqual([
      'New workspace',
      'Acme',
      'Log out of Acme',
      'Globex',
      'Log out of Globex',
    ])
  })

  await test.step('reaches the log-out icons with the keyboard', async () => {
    await switcherOf(page).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: /^Acme/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toBeFocused()
    await page.keyboard.press('Escape')
  })

  await test.step('opens a dialog with a name field and Confirm disabled while blank', async () => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'New workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'New workspace' })
    await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toBeFocused()
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('   ')
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  await test.step('creates nothing when cancelled', async () => {
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('Initech')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog', { name: 'New workspace' })).toHaveCount(0)
    await expect(switcherOf(page)).toContainText('Acme')
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Initech' })).toHaveCount(0)
  })

  await test.step('asks for confirmation before logging out and cancels cleanly', async () => {
    await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toBeVisible()
    await expect(logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Log out' })).toBeVisible()
    await expect(sidebarOf(page)).toBeVisible()
    await logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Cancel' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toHaveCount(0)
    await expect(anySignedOutScreenOf(page)).toHaveCount(0)
    await expect(sidebarOf(page)).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toBeVisible()
  })

  await test.step('closes the confirmation dialog with Escape and changes nothing', async () => {
    await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(logoutDialogOf(page, 'Acme')).toHaveCount(0)
    await expect(anySignedOutScreenOf(page)).toHaveCount(0)
    await expect(sidebarOf(page)).toBeVisible()
  })

  await test.step('uses the app text color in dark mode for the menu, the dialog and the signed-out screen', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    const sidebarColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
    await openMenu(page)
    for (const itemName of ['New workspace', 'Log out of Acme']) {
      const itemColor = await page
        .getByRole('menuitem', { name: itemName })
        .evaluate((element) => getComputedStyle(element).color)
      expect(itemColor).toBe(sidebarColor)
    }
    await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
    const dialogTitleColor = await logoutDialogOf(page, 'Acme')
      .getByRole('heading', { name: 'Log out of Acme' })
      .evaluate((element) => getComputedStyle(element).color)
    expect(dialogTitleColor).toBe(sidebarColor)
    await logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Log out' }).click()
    const signedOutColor = await signedOutScreenOf(page, 'Acme').evaluate((element) => getComputedStyle(element).color)
    expect(signedOutColor).toBe(sidebarColor)
  })
})

test('creates Initech, signed in at once, then logs out of Acme and goes to Globex', async ({ page }) => {
  await test.step('opens the new empty workspace and lists it in the menu', async () => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'New workspace' }).click()
    await page.getByRole('textbox', { name: 'Workspace name' }).fill(' Initech ')
    const sessionOpened = page.waitForResponse(
      (response) => response.url().endsWith('/auth/sessions') && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('dialog', { name: 'New workspace' })).toHaveCount(0)
    await expect(switcherOf(page)).toContainText('Initech')
    expect((await sessionOpened).status()).toBe(200)
    await expect(sidebarOf(page).getByRole('link')).toHaveCount(1)
    await expect(sidebarOf(page).getByRole('group')).toHaveCount(1)
    await expect(mainOf(page)).toContainText('Select a chat')
    expect(await menuItemNamesOf(page)).toEqual([
      'New workspace',
      'Acme',
      'Log out of Acme',
      'Globex',
      'Log out of Globex',
      'Initech',
      'Log out of Initech',
    ])
  })

  await test.step('a new workspace is signed in at once and stays signed in after a reload', async () => {
    await page.reload()
    await expect(switcherOf(page)).toContainText('Initech')
    await expect(sidebarOf(page).getByRole('group')).toHaveCount(1)
    await expect(anySignedOutScreenOf(page)).toHaveCount(0)
  })

  await test.step('lets the member build content in it without touching the other workspaces', async () => {
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Roadmap')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(sidebarOf(page).getByRole('group', { name: 'Roadmap' })).toBeVisible()
    await switchWorkspace(page, 'Acme')
    await expect(sidebarOf(page).getByRole('group', { name: 'Roadmap' })).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
  })

  await test.step('shows the signed-out screen with a link to every other signed-in workspace', async () => {
    await logOutOf(page, 'Acme')
    await expect(signedOutScreenOf(page, 'Acme')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Globex' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Initech' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Acme' })).toHaveCount(0)
    await expect(sidebarOf(page)).toHaveCount(0)
  })

  await test.step('opens the chosen workspace and keeps the signed-out one marked in the menu', async () => {
    await page.getByRole('link', { name: 'Go to Globex' }).click()
    await expect(switcherOf(page)).toContainText('Globex')
    await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: /^Acme/ })).toContainText('Signed out')
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toHaveCount(0)
  })
})

test('logs out of Globex from Acme, signs back in from its screen and its deep links', async ({ page }) => {
  await test.step('keeps the current workspace open and offers Sign in through the signed-out screen', async () => {
    await logOutOf(page, 'Globex')
    await expect(switcherOf(page)).toContainText('Acme')
    await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: /^Globex/ })).toContainText('Signed out')
    await expect(page.getByRole('menuitem', { name: 'Log out of Globex' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: /^Globex/ }).click()
    await expect(signedOutScreenOf(page, 'Globex')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Acme' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(switcherOf(page)).toContainText('Globex')
    await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
  })

  await test.step('shows the signed-out screen for a route of a signed-out workspace and opens it after Sign in', async () => {
    await switchWorkspace(page, 'Acme')
    await logOutOf(page, 'Globex')
    await navigateClientSide(page, '/w/workspace-globex/chats/chat-launch-plan')
    await expect(signedOutScreenOf(page, 'Globex')).toBeVisible()
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible()
  })

  await test.step('does not list a signed-out workspace as a destination', async () => {
    await switchWorkspace(page, 'Acme')
    await logOutOf(page, 'Globex')
    await logOutOf(page, 'Acme')
    await expect(signedOutScreenOf(page, 'Acme')).toBeVisible()
    await expect(page.getByRole('link', { name: /Go to/ })).toHaveCount(0)
  })
})

test('signing in restores the route, the messages and the draft', async ({ page }) => {
  await sidebarOf(page).getByRole('link', { name: 'Welcome' }).click()
  await composerOf(page).fill('Sent before logout')
  await composerOf(page).press('ControlOrMeta+Enter')
  await composerOf(page).fill('Draft before logout')
  const urlBeforeLogout = page.url()

  await logOutOf(page, 'Acme')
  await expect(signedOutScreenOf(page, 'Acme')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()

  expect(page.url()).toBe(urlBeforeLogout)
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(messageItemsOf(page).last()).toContainText('Sent before logout')
  await expect(composerOf(page)).toHaveValue('Draft before logout')
  await expect(anySignedOutScreenOf(page)).toHaveCount(0)
})
