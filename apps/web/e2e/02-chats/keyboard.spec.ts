import { composerOf, expect, mainOf, openChat, type Page, panelOf, panelTabOf, sidebarOf, test } from './fixtures'

const leaveTextField = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
const pressAndClose = async (page: Page, key: string, dialogName: string) => {
  await page.keyboard.press(key)
  await expect(page.getByRole('dialog', { name: dialogName })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: dialogName })).toHaveCount(0)
}

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openChat(page, 'Welcome')
    await leaveTextField(page)
  })

  test('As a member, I move around the workspace with single keys and find them all in the help', {
    tag: ['@spec-53', '@smoke'],
  }, async ({ page }) => {
    await test.step('lists the shortcuts, each named from its key', async () => {
      await page.keyboard.press('?')
      const help = page.getByRole('list', { name: 'Keyboard shortcuts' })
      await expect(help.getByRole('listitem').filter({ hasText: 'Left sidebar collapse' })).toContainText('L')
      await expect(help.getByRole('listitem').filter({ hasText: 'Right sidebar: Sources' })).toContainText('R then 2')
      await expect(help.getByRole('listitem').filter({ hasText: 'Search the workspace' })).toContainText('/')
      await expect(help.getByRole('listitem').filter({ hasText: 'Find in this chat' })).toContainText('F')
      await page.keyboard.press('Escape')
      await expect(help).toHaveCount(0)
    })

    await test.step('collapses and expands the left sidebar with L, its tooltip starting with a bold L', async () => {
      await sidebarOf(page).getByRole('button', { name: 'Left sidebar collapse' }).hover()
      await expect(page.getByRole('tooltip', { name: 'Left sidebar collapse' }).locator('strong')).toHaveText('L')
      await page.keyboard.press('l')
      await expect(sidebarOf(page).getByRole('button', { name: 'Left sidebar expansion' })).toBeVisible()
      await page.keyboard.press('l')
      await expect(sidebarOf(page).getByRole('button', { name: 'Left sidebar collapse' })).toBeVisible()
    })

    await test.step('closes the right sidebar with R, and R then a number opens it on that tab', async () => {
      await page.keyboard.press('r')
      await expect(panelOf(page)).toBeHidden()
      await expect(mainOf(page).getByRole('button', { name: 'Right sidebar expansion' })).toBeVisible()
      await page.keyboard.press('r')
      await page.keyboard.press('2')
      await expect(panelOf(page)).toBeVisible()
      await expect(panelTabOf(page, 'Sources')).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('r')
      await page.keyboard.press('1')
      await expect(panelTabOf(page, 'Browser')).toHaveAttribute('aria-selected', 'true')
    })

    await test.step('opens chat creation, project creation and browsing channels with C, P and B', async () => {
      await pressAndClose(page, 'c', 'New chat')
      await pressAndClose(page, 'p', 'New project')
      await pressAndClose(page, 'b', 'Browse channels')
    })

    await test.step('goes to the workspace settings with S and the profile with I', async () => {
      await page.keyboard.press('s')
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
      await page.keyboard.press('i')
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    })
  })

  test('As a member, I type a letter in the composer and it stays text instead of a shortcut', {
    tag: ['@spec-53'],
  }, async ({ page }) => {
    await composerOf(page).focus()
    await page.keyboard.type('cpl')
    await expect(composerOf(page)).toHaveValue('cpl')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('button', { name: 'Left sidebar collapse' })).toBeVisible()
  })
})
