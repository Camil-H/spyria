import { mkdirSync, rmSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, type Page } from '@playwright/test'
import { mainOf, switcherOf } from '../fixtures.ts'
import type { WorkerStack } from '../stack'
import { providerLoginLockPath } from '../stack-ports.ts'

export * from '../fixtures.ts'

export const signedOutScreenOf = (page: Page, workspaceName: string) =>
  page.getByText(`You are signed out of ${workspaceName}`)
export const anySignedOutScreenOf = (page: Page) => page.getByText(/You are signed out of/)
export const signInButtonOf = (page: Page) => page.getByRole('button', { name: 'Sign in' })
const staleLockMilliseconds = 60_000
const withProviderLoginLock = async <Result>(work: () => Promise<Result>) => {
  for (;;) {
    try {
      mkdirSync(providerLoginLockPath)
      break
    } catch {
      const heldSince = statSync(providerLoginLockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()
      if (Date.now() - heldSince > staleLockMilliseconds)
        rmSync(providerLoginLockPath, { recursive: true, force: true })
      else await sleep(100)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(providerLoginLockPath, { recursive: true, force: true })
  }
}

export const logInAtProvider = (popup: Page, email: string) =>
  withProviderLoginLock(async () => {
    const popupClosed = popup.waitForEvent('close')
    await popup.locator('#login').fill(email)
    await popup.locator('#password').fill('password')
    await popup.locator('#submit-login').click()
    await popupClosed
  })
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
export const membersSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Members' })
export const pendingInvitesOf = (page: Page) =>
  membersSectionOf(page).getByRole('list', { name: 'Pending invites' }).getByRole('listitem')
export const invite = async (page: Page, email: string) => {
  const form = membersSectionOf(page).getByRole('form', { name: 'Invite member' })
  await form.getByRole('textbox', { name: 'Email' }).fill(email)
  await form.getByRole('combobox', { name: 'Role' }).selectOption('member')
  await form.getByRole('button', { name: 'Invite' }).click()
}
