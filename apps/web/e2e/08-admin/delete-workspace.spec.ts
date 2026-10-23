import { expect, mainOf, type Page, sidebarOf, switcherOf, test } from '../fixtures'

const deleteSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Delete workspace' })
const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete workspace' })

test.describe('Delete workspace', () => {
  test('As an Admin, I delete the workspace after typing DELETE and land in my other workspace', async ({
    page,
    workerStack,
  }) => {
    await page.goto('/w/workspace-acme/settings')
    await deleteSectionOf(page).getByRole('button', { name: 'Delete workspace' }).click()
    const dialog = deleteDialogOf(page)
    await expect(dialog).toContainText('Every member loses access at once')
    await expect(dialog).toContainText('uninstall it there')
    const confirm = dialog.getByRole('button', { name: 'Delete workspace' })
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('delete')
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
    await confirm.click()

    await expect(switcherOf(page)).toContainText('Globex')
    await switcherOf(page).click()
    await expect(page.getByRole('menuitem', { name: /Acme/ })).toHaveCount(0)
    const [workspace] = await workerStack.database.$client`
      select deleted_at from workspaces where workspace_id = 'workspace-acme'`
    expect(workspace?.deleted_at).not.toBeNull()
  })

  test.describe('as a member', () => {
    test.use({ signedInAs: 'member-bob' })

    test('As a member who is not an Admin, I see no way to delete the workspace', async ({ page }) => {
      await page.goto('/w/workspace-acme/settings')
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
      await expect(deleteSectionOf(page)).toHaveCount(0)
      await expect(sidebarOf(page)).toBeVisible()
    })
  })
})
