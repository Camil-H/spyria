import { expect, type Page } from '@playwright/test'
import { switcherOf } from '../fixtures.ts'
import type { WorkerStack } from '../stack'

export * from '../fixtures.ts'

export const signedOutScreenOf = (page: Page, workspaceName: string) =>
  page.getByText(`You are signed out of ${workspaceName}`)
export const anySignedOutScreenOf = (page: Page) => page.getByText(/You are signed out of/)
export const signInButtonOf = (page: Page) => page.getByRole('button', { name: 'Sign in' })
export const logInAtProvider = async (popup: Page, email: string) => {
  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#login').fill(email)
  await popup.locator('#password').fill('password')
  await popup.locator('#submit-login').click()
  await popupClosed
}
export const signInThroughProvider = async (page: Page, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  await logInAtProvider(await popupOpened, email)
}
export const openMenu = async (page: Page) => {
  await switcherOf(page).click()
  await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeVisible()
}
export const menuItemNamesOf = async (page: Page) => {
  await openMenu(page)
  const itemNames = await page
    .getByRole('menuitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim()))
  await page.keyboard.press('Escape')
  return itemNames
}
export const logOutOf = async (page: Page, workspaceName: string) => {
  await openMenu(page)
  await page.getByRole('menuitem', { name: `Log out of ${workspaceName}` }).click()
  await page
    .getByRole('dialog', { name: `Log out of ${workspaceName}` })
    .getByRole('button', { name: 'Log out' })
    .click()
}
export const insertWorkspaceRole = async (
  workerStack: WorkerStack,
  id: string,
  name: string,
  permissions: string[],
) => {
  await workerStack.database.$client`
    insert into workspace_roles (workspace_id, id, name, built_in) values ('workspace-acme', ${id}, ${name}, false)`
  for (const permission of permissions)
    await workerStack.database.$client`
      insert into workspace_role_permissions (workspace_id, role_id, permission)
      values ('workspace-acme', ${id}, ${permission})`
}
export const giveWorkspaceRole = (workerStack: WorkerStack, memberId: string, roleId: string) =>
  workerStack.database.$client`
    update memberships set role = ${roleId} where workspace_id = 'workspace-acme' and user_id = ${memberId}`
