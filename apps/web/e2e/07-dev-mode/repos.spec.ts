import { openPageAs } from '../stack'
import {
  configureGitHubApp,
  connectionsOf,
  expect,
  githubSectionOf,
  inPopup,
  mainOf,
  messageContaining,
  newChatDialogOf,
  newDevChat,
  openMyConnections,
  type Page,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'

const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const branchOf = (page: Page) => mainOf(page).getByRole('img', { name: 'Git branch' }).locator('xpath=..')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('Alice configures the GitHub App: the private key and secrets show only as set, and the granted repositories are listed', {
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

test('Alice connects his GitHub in Profile → connections: it reads Connected (alice-martin)', {
  tag: ['@spec-39'],
}, async ({ page }) => {
  await configureGitHubApp(page)
  await openMyConnections(page)
  const github = connectionsOf(page).getByRole('group', { name: 'GitHub account' })
  await expect(github).toContainText('Not connected')
  await inPopup(page, () => github.getByRole('button', { name: 'Connect GitHub account' }).click())
  await expect(github).toContainText('Connected (alice-martin)')
  await page.reload()
  await connectionsOf(page).getByRole('tab', { name: 'My connections' }).click()
  await expect(connectionsOf(page).getByRole('group', { name: 'GitHub account' })).toContainText('Connected (alice-martin)')
})

test('a dev runtime chat on acme/app shows the repository and its working branch, and the agent sees the cloned files', {
  tag: ['@spec-39', '@smoke'],
}, async ({ page }) => {
  await configureGitHubApp(page)
  const chatId = await newDevChat(page, 'Fix totals', 'acme/app')
  const workingBranch = `hq/fix-totals-${chatId.replace(/-/g, '').slice(0, 6)}`
  await expect(workingDirectoryOf(page)).toHaveText('acme/app')
  await expect(branchOf(page)).toHaveText(workingBranch)
  await sendMessage(page, 'stub:ls')
  await expect(messageContaining(page, 'only-in-acme-app.txt')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(branchOf(page)).toHaveText(workingBranch)
})

test('a repository with a failing .hq/setup.sh shows a setup notice with its last output lines, and the session still answers', {
  tag: ['@spec-39'],
}, async ({ page }) => {
  await configureGitHubApp(page)
  await newDevChat(page, 'Docs work', 'acme/docs')
  await sendMessage(page, 'stub:ls')
  const notice = messageContaining(page, 'The setup script .hq/setup.sh failed with exit code 127')
  await expect(notice).toContainText('docs-tool: command not found')
  await expect(messageContaining(page, 'files:.git,.hq,README.md')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
})

test('a member without admin rights sees no GitHub section, and a non-dev runtime chat asks for no repository', {
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

test('without a GitHub App, Dev shows Connect GitHub instead of the pickers (a link for an admin, text for a member), and Non-dev shows no repository', {
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
