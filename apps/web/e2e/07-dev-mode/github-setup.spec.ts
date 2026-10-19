import { openPageAs } from '../stack'
import { configureGitHubApp, expect, githubSectionOf, mainOf, newChatDialogOf, test } from './fixtures'

test.describe('GitHub setup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member who can connect GitHub, I configure the GitHub App: its private key and secrets show only as set, and the granted repositories are listed', {
    tag: ['@spec-39'],
  }, async ({ page }) => {
    const app = await configureGitHubApp(page)
    const section = githubSectionOf(page)
    await expect(section.getByRole('list', { name: 'Granted repositories' }).getByRole('listitem')).toHaveText([
      'acme/appmain',
      'acme/docsmain',
    ])
    await page.reload()
    for (const label of ['Private key', 'Client secret', 'Webhook secret']) {
      await expect(section.getByLabel(label)).toHaveValue('')
      await expect(section.getByLabel(label)).toHaveAttribute('placeholder', 'Set: enter a new value to replace it')
    }
    await expect(section.getByLabel('App id')).toHaveValue(app.appId ?? '')
    await expect(mainOf(page)).not.toContainText('PRIVATE KEY')
  })

  test('As a member without the Connect GitHub permission, I see no GitHub settings, and a non-dev runtime chat asks me for no repository', {
    tag: ['@spec-39'],
  }, async ({ page, browser, workerStack }) => {
    await configureGitHubApp(page)
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await bobPage.goto('/w/workspace-acme/settings/github')
    await expect(mainOf(bobPage).getByText('Your workspace role does not give access to this page')).toBeVisible()
    await expect(githubSectionOf(bobPage)).toHaveCount(0)
    await bobPage.getByRole('button', { name: 'New chat' }).click()
    const dialog = newChatDialogOf(bobPage)
    await dialog.getByRole('radio', { name: 'Runtime' }).check()
    await expect(dialog.getByRole('radio', { name: 'Non-dev' })).toBeChecked()
    await expect(dialog.getByLabel('Repository')).toHaveCount(0)
    await expect(dialog.getByLabel('Base branch')).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member, without a GitHub App I see Connect GitHub instead of the pickers in a dev chat (a link if I can connect GitHub, text otherwise), and Non-dev shows no repository', {
    tag: ['@spec-42'],
  }, async ({ page, browser, workerStack }) => {
    await page.getByRole('button', { name: 'New chat' }).click()
    const dialog = newChatDialogOf(page)
    await dialog.getByRole('radio', { name: 'Runtime' }).check()
    await expect(dialog.getByLabel('Repository')).toHaveCount(0)
    await dialog.getByRole('radio', { name: 'Dev', exact: true }).check()
    const connectLink = dialog.getByRole('link', { name: 'Connect GitHub in Workspace settings' })
    await expect(connectLink).toBeVisible()
    await expect(dialog.getByLabel('Repository')).toHaveCount(0)
    await expect(dialog.getByLabel('Base branch')).toHaveCount(0)
    await expect(dialog).not.toContainText('Loading…')
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await connectLink.click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Connect GitHub' })).toBeVisible()
    await expect(githubSectionOf(page)).toBeVisible()

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await bobPage.getByRole('button', { name: 'New chat' }).click()
    const bobDialog = newChatDialogOf(bobPage)
    await bobDialog.getByRole('radio', { name: 'Runtime' }).check()
    await bobDialog.getByRole('radio', { name: 'Dev', exact: true }).check()
    await expect(bobDialog.getByText('Connect GitHub in Workspace settings')).toBeVisible()
    await expect(bobDialog.getByRole('link', { name: 'Connect GitHub in Workspace settings' })).toHaveCount(0)
    await bobPage.context().close()
  })
})
