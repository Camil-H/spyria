import {
  anySignedOutScreenOf,
  expect,
  type Locator,
  logOutOf,
  mainOf,
  menuItemNamesOf,
  openMenu,
  type Page,
  projectGroupOf,
  sidebarOf,
  signedOutScreenOf,
  signInThroughProvider,
  switcherOf,
  switchWorkspace,
  test,
} from './fixtures'

const logoutDialogOf = (page: Page, workspaceName: string) =>
  page.getByRole('dialog', { name: `Log out of ${workspaceName}` })
const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
const chatRowIn = (group: Locator, chatName: string) => group.getByRole('link', { name: chatName })

const navigateClientSide = (page: Page, path: string) =>
  page.evaluate((targetPath) => {
    window.history.pushState(null, '', targetPath)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)

test.describe('Workspaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test.describe(() => {
    test.use({ signedInAs: null })

    test('As a member, I reach only the workspaces I belong to and cannot open a page of another', {
      tag: ['@spec-05'],
    }, async ({ page }) => {
      await signInThroughProvider(page, 'bob@example.com')
      await expect(switcherOf(page)).toContainText('Acme')
      expect(await menuItemNamesOf(page)).toEqual(['New workspace', 'Acme', 'Log out of Acme'])

      await page.goto('/w/workspace-globex/chats/chat-launch-plan')
      await expect(page.getByText("You don't have access to this workspace")).toBeVisible()
      await expect(sidebarOf(page)).toHaveCount(0)
      await expect(page.getByText(/Globex|Launch plan/)).toHaveCount(0)
    })
  })

  test('As a member, I create a workspace, signed in at once, build in it without touching the others, then log out of another and go to the next', async ({
    page,
  }) => {
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
      await page.getByRole('button', { name: 'Project creation' }).click()
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

  test('As a member, I switch the active workspace from its menu, whose dialogs change nothing until I confirm', async ({
    page,
  }) => {
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

    await test.step('lists both workspaces and shows only the selected workspace content', async () => {
      await switcherOf(page).click()
      await expect(page.getByRole('menuitem', { name: 'Acme', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Globex', exact: true })).toBeVisible()
      await page.getByRole('menuitem', { name: 'Globex', exact: true }).click()
      await expect(switcherOf(page)).toContainText('Globex')
      await expect(chatRowIn(projectGroupOf(page, 'Launch'), 'Launch plan')).toBeVisible()
      await expect(chatRowIn(looseChatsOf(page), 'General')).toBeVisible()
      await expect(projectGroupOf(page, 'Onboarding')).toHaveCount(0)
      await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
      await expect(sidebarOf(page).getByRole('link', { name: 'Standup' })).toHaveCount(0)
    })
  })

  test('As a member, I log out of one workspace while staying in another, and sign back in from its screen and its deep links', async ({
    page,
  }) => {
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

  test.fixme('As a member, I leave a workspace', {
    annotation: { type: 'reason', description: 'Leaving a workspace is not built yet (spec 49, 01-access)' },
  }, async () => {})
})
