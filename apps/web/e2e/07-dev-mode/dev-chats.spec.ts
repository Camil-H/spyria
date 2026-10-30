import {
  configureGitHubApp,
  expect,
  mainOf,
  messageContaining,
  newDevChat,
  type Page,
  sendMessage,
  setSetupCommand,
  test,
  workingIndicatorOf,
} from './fixtures'

const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const branchOf = (page: Page) => mainOf(page).getByRole('img', { name: 'Git branch' }).locator('xpath=..')
const openCommandStep = async (page: Page, command: string) => {
  const step = messageContaining(page, `$ ${command}`)
  await step.getByRole('button', { expanded: false }).click()
  return step
}

test.describe('Dev chats', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I start a dev chat on a repository and a base branch I pick: it shows the repository and its own working branch, and the agent works on a clone', {
    tag: ['@spec-39', '@smoke'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    const chatId = await newDevChat(page, 'Fix totals', 'acme/app', 'release')
    const workingBranch = `spyria/fix-totals-${chatId.replace(/-/g, '').slice(0, 6)}`
    await expect(workingDirectoryOf(page)).toHaveText('acme/app')
    await expect(branchOf(page)).toHaveText(workingBranch)
    await sendMessage(page, 'stub:ls')
    await expect(messageContaining(page, 'only-in-acme-app.txt')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(branchOf(page)).toHaveText(workingBranch)
  })

  test('As a member, I see a failing setup command as a notice with its last output lines, and the session still answers', {
    tag: ['@spec-39'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    await setSetupCommand(page, 'acme/docs', 'sh .spyria/setup.sh')
    await newDevChat(page, 'Docs work', 'acme/docs')
    await sendMessage(page, 'stub:ls')
    const notice = messageContaining(page, 'The setup command "sh .spyria/setup.sh" failed with exit code 127')
    await expect(notice).toContainText('docs-tool: command not found')
    await expect(messageContaining(page, 'files:.git,.spyria,README.md')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
  })

  test('As a member, my first message waits for a slow setup command, whose output streams into its conversation step while the chat says it is setting up the repository, and is answered once it ends', {
    tag: ['@spec-40', '@slow'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    await setSetupCommand(page, 'acme/docs', 'sh .spyria/setup.sh')
    await newDevChat(page, 'Docs setup', 'acme/docs')
    await sendMessage(page, 'stub:ls')
    const setup = await openCommandStep(page, 'sh .spyria/setup.sh')
    await expect(setup.locator('pre')).toContainText('installing the docs toolchain')
    await expect(page.getByRole('status', { name: 'Setting up the repository' })).toBeVisible()
    await expect(setup).not.toContainText('exit 127')
    await expect(messageContaining(page, 'files:.git,.spyria,README.md')).toHaveCount(0)
    await expect(setup.locator('pre')).toContainText('docs-tool: command not found')
    await expect(setup).toContainText('exit 127')
    await expect(page.getByRole('status', { name: 'Setting up the repository' })).toHaveCount(0)
    await expect(
      messageContaining(page, 'The setup command "sh .spyria/setup.sh" failed with exit code 127'),
    ).toHaveCount(1)
    await expect(messageContaining(page, 'files:.git,.spyria,README.md')).toHaveCount(1)
  })
})
