import {
  chooseRunsOn,
  connectionsOf,
  expect,
  inPopup,
  mainOf,
  messageContaining,
  openMyConnections,
  openSettings,
  type Page,
  sendMessage,
  serverUrl,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs } from './stack'

const githubSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'GitHub' })
const newChatDialogOf = (page: Page) => page.getByRole('dialog', { name: 'New chat' })
const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const branchOf = (page: Page) => mainOf(page).getByRole('img', { name: 'Git branch' }).locator('xpath=..')

const configureGitHubApp = async (page: Page) => {
  const app = (await (await fetch(`${serverUrl}/test/github-app`)).json()) as Record<string, string>
  await openSettings(page)
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

const newDevChat = async (page: Page, name: string, repository: string) => {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(page)
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await dialog.getByRole('radio', { name: 'Dev', exact: true }).check()
  await dialog.getByLabel('Repository').selectOption(repository)
  await expect(dialog.getByLabel('Base branch')).toHaveValue('main')
  await dialog.getByRole('textbox', { name: 'Chat name' }).fill(name)
  await dialog.getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
  await chooseRunsOn(page, 'HQ runtime')
  return page.url().split('/').at(-1) ?? ''
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('1. Alice configures the GitHub App: the private key and secrets show only as set, and the granted repositories are listed', async ({
  page,
}) => {
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

test('2. Alice connects his GitHub in Profile → connections: it reads Connected (alice-martin)', async ({ page }) => {
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

test('3. a dev runtime chat on acme/app shows the repository and its working branch, and the agent sees the cloned files', async ({
  page,
}) => {
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

test('4. a repository with a failing .hq/setup.sh shows a setup notice with its last output lines, and the session still answers', async ({
  page,
}) => {
  await configureGitHubApp(page)
  await newDevChat(page, 'Docs work', 'acme/docs')
  await sendMessage(page, 'stub:ls')
  const notice = messageContaining(page, 'The setup script .hq/setup.sh failed with exit code 127')
  await expect(notice).toContainText('docs-tool: command not found')
  await expect(messageContaining(page, 'files:.git,.hq,README.md')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
})

test('5. a member without admin rights sees no GitHub section, and a non-dev runtime chat asks for no repository', async ({
  page,
  browser,
  workerStack,
}) => {
  await configureGitHubApp(page)
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await bobPage.goto('/w/workspace-acme/settings')
  await expect(mainOf(bobPage).getByText('Only workspace admins can see this page')).toBeVisible()
  await expect(githubSectionOf(bobPage)).toHaveCount(0)
  await bobPage.getByRole('button', { name: 'New chat' }).click()
  const dialog = newChatDialogOf(bobPage)
  await dialog.getByRole('radio', { name: 'Runtime' }).check()
  await expect(dialog.getByRole('radio', { name: 'Non-dev' })).toBeChecked()
  await expect(dialog.getByLabel('Repository')).toHaveCount(0)
  await expect(dialog.getByLabel('Base branch')).toHaveCount(0)
  await bobPage.context().close()
})
