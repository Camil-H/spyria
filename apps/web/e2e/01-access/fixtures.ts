import { expect, type Page } from '@playwright/test'
import { switcherOf } from '../fixtures.ts'

export * from '../fixtures.ts'

export const signedOutScreenOf = (page: Page, workspaceName: string) =>
  page.getByText(`You are signed out of ${workspaceName}`)
export const signInButtonOf = (page: Page) => page.getByRole('button', { name: 'Sign in' })
export const signInThroughDex = async (page: Page, email: string) => {
  const popupOpened = page.waitForEvent('popup')
  await signInButtonOf(page).click()
  const popup = await popupOpened
  const popupClosed = popup.waitForEvent('close')
  await popup.locator('#login').fill(email)
  await popup.locator('#password').fill('password')
  await popup.locator('#submit-login').click()
  await popupClosed
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
