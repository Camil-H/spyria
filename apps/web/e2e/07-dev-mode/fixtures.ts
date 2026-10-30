import { expect, type Page } from '@playwright/test'
import {
  answerNewAiChat,
  chooseRunsOn,
  connectionsOf,
  inPopup,
  mainOf,
  newChatDialogOf,
  openMyConnections,
  openSettings,
  panelTabOf,
} from '../fixtures.ts'

export * from '../fixtures.ts'

export const connectGitHub = async (page: Page) => {
  await openMyConnections(page)
  const github = connectionsOf(page).getByRole('group', { name: 'GitHub account' })
  await inPopup(page, () => github.getByRole('button', { name: 'Connect GitHub account' }).click())
  await expect(github).toContainText('Connected (alice-martin)')
  await page.goto('/')
}
export const newDevChat = async (page: Page, name: string, repository: string, baseBranch = 'main') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(page)
  await answerNewAiChat(dialog, { needsGitHub: true })
  await dialog.getByLabel('Repository').selectOption(repository)
  await expect(dialog.getByLabel('Base branch')).toHaveValue('main')
  await dialog.getByLabel('Base branch').selectOption(baseBranch)
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  await chooseRunsOn(page, 'Spyria runtime')
  await panelTabOf(page, 'Files').click()
  return page.url().split('/').at(-1) ?? ''
}
export const setSetupCommand = async (page: Page, repository: string, command: string) => {
  await openSettings(page, 'Connect runtime')
  const section = mainOf(page).getByRole('region', { name: 'Setup commands' })
  const tab = section
    .getByRole('tablist', { name: 'Setup commands' })
    .getByRole('tab', { name: repository, exact: true })
  if ((await tab.count()) === 0) {
    await section.getByRole('tab', { name: 'New repository setup command' }).click()
    await section.getByRole('combobox', { name: 'Repository' }).selectOption(repository)
  } else {
    await tab.click()
  }
  await section.getByLabel('Setup command', { exact: true }).fill(command)
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText('Saved')).toBeVisible()
  await page.goto('/')
}
