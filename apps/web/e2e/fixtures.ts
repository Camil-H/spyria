import { expect, type Locator, type Page } from '@playwright/test'

export * from '@playwright/test'
export { test } from './stack.ts'
export { serverUrl } from './stack-ports.ts'

export const agentReplyText = 'Understood, working on it.'

export const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
export const mainOf = (page: Page) => page.getByRole('main')
export const switcherOf = (page: Page) => page.getByRole('button', { name: 'Switch workspace' })
export const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
export const sendButtonOf = (page: Page) => page.getByRole('button', { name: 'Send' })
export const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')
export const chatLinkOf = (page: Page, chatName: string) => sidebarOf(page).getByRole('link', { name: chatName })
export const projectGroupOf = (page: Page, projectName: string) =>
  sidebarOf(page).getByRole('group', { name: projectName })
export const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
export const chatRowIn = (group: Locator, chatName: string) => group.getByRole('link', { name: chatName })
export const draftIconOf = (page: Page, chatName: string) =>
  chatLinkOf(page, chatName).getByRole('img', { name: 'Has unsent draft' })

export const openChat = async (page: Page, chatName: string) => {
  await chatLinkOf(page, chatName).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

export const sendMessage = async (page: Page, text: string) => {
  await composerOf(page).fill(text)
  await composerOf(page).press('ControlOrMeta+Enter')
}

export const runsOnChoiceOf = (page: Page) => mainOf(page).getByRole('group', { name: 'Runs on' })
export const chooseRunsOn = async (page: Page, runsOn: string) => {
  const radio = runsOnChoiceOf(page).getByRole('radio', { name: runsOn })
  const notice = mainOf(page).getByText('Choose where this chat runs to send')
  await expect
    .poll(async () => ((await radio.isVisible()) ? 'choose' : (await notice.isVisible()) ? 'waiting' : 'chosen'))
    .not.toBe('waiting')
  if (await radio.isVisible()) await radio.click()
  await expect(runsOnChoiceOf(page)).toHaveCount(0)
}
export const newRuntimeChat = async (page: Page, name: string, runsOn: string | null = 'HQ runtime') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New chat' })
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  if (runsOn) await chooseRunsOn(page, runsOn)
  return page.url().split('/').at(-1) ?? ''
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
