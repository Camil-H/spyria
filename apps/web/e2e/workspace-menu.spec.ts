import { expect, type Page, test } from './fixtures'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const mainOf = (page: Page) => page.getByRole('main')
const switcherOf = (page: Page) => page.getByRole('button', { name: 'Switch workspace' })
const logoutDialogOf = (page: Page, workspaceName: string) =>
  page.getByRole('dialog', { name: `Log out of ${workspaceName}` })
const signedOutScreenOf = (page: Page) => page.getByText(/You are signed out of/)
const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')

const openMenu = async (page: Page) => {
  await switcherOf(page).click()
  await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeVisible()
}

const logOutOf = async (page: Page, workspaceName: string) => {
  await openMenu(page)
  await page.getByRole('menuitem', { name: `Log out of ${workspaceName}` }).click()
  await logoutDialogOf(page, workspaceName).getByRole('button', { name: 'Log out' }).click()
}

const createWorkspace = async (page: Page, workspaceName: string) => {
  await openMenu(page)
  await page.getByRole('menuitem', { name: 'New workspace' }).click()
  await page.getByRole('textbox', { name: 'Workspace name' }).fill(workspaceName)
  await page.getByRole('button', { name: 'Confirm' }).click()
}

const navigateClientSide = (page: Page, path: string) =>
  page.evaluate((targetPath) => {
    window.history.pushState(null, '', targetPath)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. menu content', () => {
  test('lists New workspace first, then each workspace with its log-out icon', async ({ page }) => {
    await openMenu(page)
    const itemNames = await page
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim()))
    expect(itemNames).toEqual(['New workspace', 'Acme', 'Log out of Acme', 'Globex', 'Log out of Globex'])
  })

  test('has no log-out icon while the menu is closed and closes with Escape', async ({ page }) => {
    await expect(page.getByRole('menuitem', { name: /Log out of/ })).toHaveCount(0)
    await openMenu(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: /Log out of/ })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'New workspace' })).toHaveCount(0)
  })

  test('reaches the log-out icons with the keyboard', async ({ page }) => {
    await switcherOf(page).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: /^Acme/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toBeFocused()
  })

  test('keeps switching workspace by choosing its name', async ({ page }) => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: /^Globex/ }).click()
    await expect(switcherOf(page)).toContainText('Globex')
    await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
  })
})

test.describe('2. new workspace dialog', () => {
  const openNewWorkspaceDialog = async (page: Page) => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'New workspace' }).click()
  }

  test('opens a dialog with a name field and Confirm disabled while blank', async ({ page }) => {
    await openNewWorkspaceDialog(page)
    const dialog = page.getByRole('dialog', { name: 'New workspace' })
    await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toBeFocused()
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('   ')
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  test('creates nothing when cancelled', async ({ page }) => {
    await openNewWorkspaceDialog(page)
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('Initech')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog', { name: 'New workspace' })).toHaveCount(0)
    await expect(switcherOf(page)).toContainText('Acme')
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Initech' })).toHaveCount(0)
  })
})

test.describe('3. create a workspace', () => {
  test('opens the new empty workspace and lists it in the menu', async ({ page }) => {
    await createWorkspace(page, ' Initech ')

    await expect(page.getByRole('dialog', { name: 'New workspace' })).toHaveCount(0)
    await expect(switcherOf(page)).toContainText('Initech')
    await expect(sidebarOf(page).getByRole('link')).toHaveCount(1)
    await expect(sidebarOf(page).getByRole('group')).toHaveCount(1)
    await expect(mainOf(page)).toContainText('Select a chat')

    await openMenu(page)
    const itemNames = await page
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim()))
    expect(itemNames).toEqual([
      'New workspace',
      'Acme',
      'Log out of Acme',
      'Globex',
      'Log out of Globex',
      'Initech',
      'Log out of Initech',
    ])
  })

  test('lets the member build content in it without touching the other workspaces', async ({ page }) => {
    await createWorkspace(page, 'Initech')
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Roadmap')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(sidebarOf(page).getByRole('group', { name: 'Roadmap' })).toBeVisible()

    await openMenu(page)
    await page.getByRole('menuitem', { name: /^Acme/ }).click()
    await expect(sidebarOf(page).getByRole('group', { name: 'Roadmap' })).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
  })
})

test.describe('4. confirmation', () => {
  test('asks for confirmation before logging out and cancels cleanly', async ({ page }) => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toBeVisible()
    await expect(logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Log out' })).toBeVisible()
    await expect(sidebarOf(page)).toBeVisible()

    await logoutDialogOf(page, 'Acme').getByRole('button', { name: 'Cancel' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toHaveCount(0)
    await expect(signedOutScreenOf(page)).toHaveCount(0)
    await expect(sidebarOf(page)).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toBeVisible()
  })
})

test.describe('4b. escape', () => {
  test('closes the confirmation dialog with Escape and changes nothing', async ({ page }) => {
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'Log out of Acme' }).click()
    await expect(logoutDialogOf(page, 'Acme')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(logoutDialogOf(page, 'Acme')).toHaveCount(0)
    await expect(signedOutScreenOf(page)).toHaveCount(0)
    await expect(sidebarOf(page)).toBeVisible()
  })
})

test.describe('5. log out of the current workspace', () => {
  test('shows the signed-out screen with a link to every other signed-in workspace', async ({ page }) => {
    await createWorkspace(page, 'Initech')
    await openMenu(page)
    await page.getByRole('menuitem', { name: /^Acme/ }).click()
    await logOutOf(page, 'Acme')

    await expect(page.getByText('You are signed out of Acme')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Globex' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Initech' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Acme' })).toHaveCount(0)
    await expect(sidebarOf(page)).toHaveCount(0)
  })
})

test.describe('6. pick a workspace', () => {
  test('opens the chosen workspace and keeps the signed-out one marked in the menu', async ({ page }) => {
    await logOutOf(page, 'Acme')
    await page.getByRole('link', { name: 'Go to Globex' }).click()

    await expect(switcherOf(page)).toContainText('Globex')
    await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: /^Acme/ })).toContainText('Signed out')
    await expect(page.getByRole('menuitem', { name: 'Log out of Acme' })).toHaveCount(0)
  })

  test('does not list a signed-out workspace as a destination', async ({ page }) => {
    await logOutOf(page, 'Globex')
    await logOutOf(page, 'Acme')
    await expect(page.getByText('You are signed out of Acme')).toBeVisible()
    await expect(page.getByRole('link', { name: /Go to/ })).toHaveCount(0)
  })
})

test.describe('7. sign in', () => {
  test('restores the route, the messages and the draft', async ({ page }) => {
    await sidebarOf(page).getByRole('link', { name: 'Welcome' }).click()
    await composerOf(page).fill('Sent before logout')
    await composerOf(page).press('ControlOrMeta+Enter')
    await composerOf(page).fill('Draft before logout')
    const urlBeforeLogout = page.url()

    await logOutOf(page, 'Acme')
    await expect(page.getByText('You are signed out of Acme')).toBeVisible()
    await page.getByRole('button', { name: 'Sign in' }).click()

    expect(page.url()).toBe(urlBeforeLogout)
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
    await expect(messageItemsOf(page).last()).toContainText('Sent before logout')
    await expect(composerOf(page)).toHaveValue('Draft before logout')
    await expect(page.getByText(/You are signed out of/)).toHaveCount(0)
  })
})

test.describe('8. log out of another workspace', () => {
  test('keeps the current workspace open and offers Sign in through the signed-out screen', async ({ page }) => {
    await logOutOf(page, 'Globex')

    await expect(switcherOf(page)).toContainText('Acme')
    await expect(sidebarOf(page).getByRole('group', { name: 'Onboarding' })).toBeVisible()
    await openMenu(page)
    await expect(page.getByRole('menuitem', { name: /^Globex/ })).toContainText('Signed out')
    await expect(page.getByRole('menuitem', { name: 'Log out of Globex' })).toHaveCount(0)

    await page.getByRole('menuitem', { name: /^Globex/ }).click()
    await expect(page.getByText('You are signed out of Globex')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Acme' })).toBeVisible()

    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(switcherOf(page)).toContainText('Globex')
    await expect(sidebarOf(page).getByRole('group', { name: 'Launch' })).toBeVisible()
  })
})

test.describe('9. deep links', () => {
  test('shows the signed-out screen for a route of a signed-out workspace and opens it after Sign in', async ({
    page,
  }) => {
    await logOutOf(page, 'Globex')
    await navigateClientSide(page, '/w/workspace-globex/chats/chat-launch-plan')

    await expect(page.getByText('You are signed out of Globex')).toBeVisible()
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible()
  })
})

test.describe('10. theming', () => {
  test('uses the app text color in dark mode for the menu, the dialog and the signed-out screen', async ({ page }) => {
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
    const signedOutColor = await page
      .getByText('You are signed out of Acme')
      .evaluate((element) => getComputedStyle(element).color)
    expect(signedOutColor).toBe(sidebarColor)
  })
})
