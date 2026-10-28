import { openPageAs } from '../stack'
import {
  configureGitHubApp,
  expect,
  githubSectionOf,
  mainOf,
  newChatDialogOf,
  openSettings,
  sidebarOf,
  test,
} from './fixtures'

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

  test("As an admin, I connect GitHub in one click: GitHub creates the app with Spyria's permissions and events, I pick repositories, and Spyria shows the app connected (a tick, no creation form, the status on the settings card)", {
    tag: ['@spec-51'],
  }, async ({ page }) => {
    await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
    const card = mainOf(page).getByRole('link', { name: 'Connect GitHub', exact: true })
    await expect(card).toHaveAccessibleDescription('The GitHub App dev chats clone and push with')
    await card.click()
    const appOrigin = new URL(page.url()).origin
    const section = githubSectionOf(page)
    await expect(section.getByText('GitHub App connected')).toHaveCount(0)
    const creation = section.getByRole('form', { name: 'Create the GitHub App' })
    await creation.getByRole('radio', { name: 'An organization' }).check()
    await creation.getByLabel('Organization login').fill('acme-corp')
    await creation.getByRole('button', { name: 'Create the GitHub App on GitHub' }).click()

    await expect(page.getByRole('heading', { name: 'Create GitHub App for acme-corp' })).toBeVisible()
    const manifest = JSON.parse((await page.locator('pre').textContent()) ?? '{}')
    expect(manifest).toMatchObject({
      url: appOrigin,
      hook_attributes: { url: `${appOrigin}/api/github/webhooks`, active: true },
      callback_urls: [`${appOrigin}/auth/github/callback`],
      setup_url: `${appOrigin}/w/workspace-acme/settings/github`,
      public: false,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'read',
        checks: 'read',
        actions: 'read',
        metadata: 'read',
        workflows: 'write',
      },
      default_events: [
        'pull_request',
        'pull_request_review',
        'pull_request_review_comment',
        'pull_request_review_thread',
        'check_suite',
        'check_run',
      ],
    })
    await page.getByRole('button', { name: 'Create GitHub App' }).click()
    await expect(page.getByRole('heading', { name: `Install ${manifest.name}` })).toBeVisible()
    await page.getByRole('button', { name: 'Install' }).click()

    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Connect GitHub' })).toBeVisible()
    const connected = section.getByRole('status').filter({ hasText: 'GitHub App connected' })
    await expect(connected).toBeVisible()
    await expect(connected).toHaveAttribute('title', 'GitHub App connected')
    await expect(creation).toHaveCount(0)
    await expect(section.getByRole('list', { name: 'Granted repositories' }).getByRole('listitem')).toHaveText([
      'acme/appmain',
      'acme/docsmain',
    ])
    await expect(mainOf(page)).not.toContainText('PRIVATE KEY')
    await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(card).toHaveAccessibleDescription('The GitHub App dev chats clone and push with GitHub App connected')
  })

  test("As an admin, I see how to create the GitHub App manually with this workspace's webhook and callback URLs, folded until I open it", {
    tag: ['@spec-51'],
  }, async ({ page }) => {
    await openSettings(page, 'Connect GitHub')
    const section = githubSectionOf(page)
    const appOrigin = new URL(page.url()).origin
    await expect(section.getByText(`${appOrigin}/api/github/webhooks`, { exact: true })).toBeHidden()
    await section.getByText('How to create the GitHub App').click()
    for (const url of [appOrigin, `${appOrigin}/auth/github/callback`, `${appOrigin}/api/github/webhooks`])
      await expect(section.getByText(url, { exact: true })).toBeVisible()
    for (const name of ['Homepage URL', 'Callback URL', 'Webhook URL'])
      await expect(section.getByRole('button', { name: `Copy ${name}` })).toBeVisible()
    await expect(section).toContainText(
      'Repository permissions: Contents: Read and write, Pull requests: Read and write, Issues: Read-only, Checks: Read-only, Actions: Read-only, Metadata: Read-only, Workflows: Read and write.',
    )
    await expect(section).toContainText(
      'Subscribe to events: Pull request, Pull request review, Pull request review comment, Pull request review thread, Check suite, Check run.',
    )
    await configureGitHubApp(page)
    await page.reload()
    await expect(section.getByText(`${appOrigin}/api/github/webhooks`, { exact: true })).toBeHidden()
    await section.getByText('How to create the GitHub App').click()
    await expect(section.getByText(`${appOrigin}/api/github/webhooks`, { exact: true })).toBeVisible()
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
