import { expect, type Page } from '@playwright/test'
import {
  chooseRunsOn,
  connectionsOf,
  inPopup,
  mainOf,
  openMyConnections,
  openSettings,
  serverUrl,
} from '../fixtures.ts'

export * from '../fixtures.ts'

export const githubSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'GitHub' })
export const newChatDialogOf = (page: Page) => page.getByRole('dialog', { name: 'New chat' })
export const connectGitHub = async (page: Page) => {
  await openMyConnections(page)
  const github = connectionsOf(page).getByRole('group', { name: 'GitHub account' })
  await inPopup(page, () => github.getByRole('button', { name: 'Connect GitHub account' }).click())
  await expect(github).toContainText('Connected (alice-martin)')
  await page.goto('/')
}
export const configureGitHubApp = async (page: Page) => {
  const app = (await (await fetch(`${serverUrl}/test/github-app`)).json()) as Record<string, string>
  await openSettings(page, 'Connect GitHub')
  const section = githubSectionOf(page)
  await section.getByLabel('App id').fill(app.appId ?? '')
  await section.getByLabel('Client id').fill(app.clientId ?? '')
  await section.getByLabel('Private key').fill(app.privateKey ?? '')
  await section.getByLabel('Client secret').fill(app.clientSecret ?? '')
  await section.getByLabel('Webhook secret').fill('e2e-webhook-secret')
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText('Saved')).toBeVisible()
  return app
}
export const newDevChat = async (page: Page, name: string, repository: string, baseBranch = 'main') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(page)
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('radio', { name: 'Dev', exact: true }).check()
  await dialog.getByLabel('Repository').selectOption(repository)
  await expect(dialog.getByLabel('Base branch')).toHaveValue('main')
  await dialog.getByLabel('Base branch').selectOption(baseBranch)
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  await chooseRunsOn(page, 'HQ runtime')
  return page.url().split('/').at(-1) ?? ''
}
