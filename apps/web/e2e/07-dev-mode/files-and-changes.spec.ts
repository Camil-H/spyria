import {
  configureGitHubApp,
  expect,
  messageContaining,
  newDevChat,
  type Page,
  panelOf,
  panelTabOf,
  sendMessage,
  serverUrl,
  tabPanelOf,
  test,
  workingIndicatorOf,
} from './fixtures'

const appFix = {
  path: 'src/app.ts',
  oldText: 'export const total = 1\n',
  newText: 'export const total = 2\n',
}
const commitCommand = `git add -A && git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qm 'Fix the totals'`
const treeRowOf = (page: Page, name: string) => tabPanelOf(page).getByRole('button', { name, exact: false })
const changeOf = (page: Page, path: string) =>
  tabPanelOf(page).getByRole('button', { name: new RegExp(`^${path.replace('.', '\\.')}`) })
const openCommandStep = async (page: Page, command: string) => {
  const step = messageContaining(page, `$ ${command}`)
  await step.getByRole('button', { expanded: false }).click()
  return step
}
const finished = (page: Page) => expect(workingIndicatorOf(page)).toHaveCount(0)

const devChatWithEdits = async (
  page: Page,
  agentScript: (chatId: string, script: object) => Promise<void>,
  name: string,
  extraSteps: object[] = [],
) => {
  await configureGitHubApp(page)
  const chatId = await newDevChat(page, name, 'acme/app')
  await agentScript(chatId, {
    steps: [{ edit: appFix }, { edit: { path: 'src/new.ts', create: 'export const added = true\n' } }, ...extraSteps],
    text: 'Edited the totals.',
  })
  await sendMessage(page, 'Fix the totals')
  await expect(messageContaining(page, 'Edited the totals.')).toHaveCount(1)
  await finished(page)
  return chatId
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('Files shows the repository tree without .git, and opening README.md shows its content highlighted', {
  tag: ['@spec-40'],
}, async ({ page }) => {
  await configureGitHubApp(page)
  await newDevChat(page, 'Browse files', 'acme/app')
  await sendMessage(page, 'stub:ls')
  await expect(messageContaining(page, 'only-in-acme-app.txt')).toHaveCount(1)
  await finished(page)
  await expect(panelTabOf(page, 'Files')).toHaveAttribute('aria-selected', 'true')
  const rows = tabPanelOf(page).getByRole('list').first().getByRole('listitem')
  await expect(rows).toHaveText(['src', 'AGENTS.md', 'only-in-acme-app.txt', 'README.md'])
  await expect(tabPanelOf(page).getByText('.git', { exact: true })).toHaveCount(0)
  await treeRowOf(page, 'README.md').click()
  const viewer = tabPanelOf(page).getByRole('region', { name: 'README.md' })
  await expect(viewer.locator('code')).toHaveText('# acme app')
  await expect(viewer.locator('code [class^="hljs-"]').first()).toBeVisible()
  await viewer.getByRole('button', { name: 'All files' }).click()
  await treeRowOf(page, 'src').click()
  await treeRowOf(page, 'app.ts').click()
  const source = tabPanelOf(page).getByRole('region', { name: 'src/app.ts' })
  await expect(source.locator('code .hljs-keyword').first()).toHaveText('export')
})

test('after the agent edits src/app.ts and creates src/new.ts, Changes lists both with their diff and Files marks them', {
  tag: ['@spec-40'],
}, async ({ page, agentScript }) => {
  await devChatWithEdits(page, agentScript, 'Edit totals')
  const src = treeRowOf(page, 'src')
  await expect(src.getByRole('img', { name: 'Contains changes' })).toBeVisible()
  await src.click()
  await expect(treeRowOf(page, 'app.ts').getByRole('img', { name: 'Modified' })).toBeVisible()
  await expect(treeRowOf(page, 'new.ts').getByRole('img', { name: 'Added' })).toBeVisible()
  await expect(treeRowOf(page, 'README.md').getByRole('img')).toHaveCount(0)

  await panelTabOf(page, 'Changes').click()
  await expect(changeOf(page, 'src/app.ts')).toContainText(/Modified \+1 [−-]1/)
  await expect(changeOf(page, 'src/new.ts')).toContainText(/Added \+1 [−-]0/)
  const diff = tabPanelOf(page).getByRole('table', { name: 'Diff of src/app.ts' })
  await expect(diff).toContainText('- export const total = 1')
  await expect(diff).toContainText('+ export const total = 2')
})

test('a running command shows its output live in its conversation step, then its exit code; the panel has no Terminal tab', {
  tag: ['@spec-40'],
}, async ({ page, agentScript, heldCommand, release }) => {
  await configureGitHubApp(page)
  const chatId = await newDevChat(page, 'Run tests', 'acme/app')
  const command = `printf 'running 3 tests\\n' && ${heldCommand('tests')} && printf '3 passed\\n'`
  await agentScript(chatId, { steps: [{ command }], text: 'The tests pass.' })
  await sendMessage(page, 'Run the tests')
  const step = await openCommandStep(page, command)
  const output = step.locator('pre')
  await expect(output).toContainText('running 3 tests')
  await expect(step.getByRole('img', { name: 'Running' })).toBeVisible()
  await expect(output).not.toContainText(/running 3 tests\s+3 passed/)
  await release('tests')
  await expect(output).toContainText(/running 3 tests\s+3 passed/)
  await expect(step).toContainText('exit 0')
  await expect(panelTabOf(page, 'Terminal')).toHaveCount(0)
  await expect(panelOf(page).getByRole('textbox')).toHaveCount(0)
})

test('after the agent commits, Commits lists the commit and Changes still shows the diff against base', {
  tag: ['@spec-40'],
}, async ({ page, agentScript }) => {
  await devChatWithEdits(page, agentScript, 'Commit totals', [{ command: commitCommand }])
  await panelTabOf(page, 'Commits').click()
  const commits = tabPanelOf(page).getByRole('listitem')
  await expect(commits).toHaveCount(1)
  await expect(commits.first()).toContainText('Fix the totals')
  await expect(commits.first()).toContainText(/Pi Agent · \d\d:\d\d UTC/)
  await panelTabOf(page, 'Changes').click()
  await expect(changeOf(page, 'src/app.ts')).toContainText(/Modified \+1 [−-]1/)
  await expect(changeOf(page, 'src/new.ts')).toContainText(/Added \+1 [−-]0/)
})

test('a stopped runtime shows the last snapshot as asleep, and Wake restarts it and refreshes the tabs', {
  tag: ['@spec-40', '@slow'],
}, async ({ page, agentScript, workerStack }) => {
  const chatId = await devChatWithEdits(page, agentScript, 'Sleepy totals')
  await expect
    .poll(async () =>
      String(
        (await workerStack.database.$client`select workspace_snapshot from runtimes where chat_id = ${chatId}`)[0]
          ?.workspace_snapshot,
      ),
    )
    .toContain('src/new.ts')
  await fetch(
    `${serverUrl}/test/runtime?${new URLSearchParams({ db: workerStack.databaseName, chat: chatId, stop: 'true' })}`,
    {
      method: 'POST',
    },
  )
  const asleep = tabPanelOf(page).getByRole('status').filter({ hasText: 'Runtime asleep' })
  await panelTabOf(page, 'Changes').click()
  await expect(asleep).toBeVisible()
  await expect(changeOf(page, 'src/app.ts')).toContainText(/Modified \+1 [−-]1/)
  await panelTabOf(page, 'Files').click()
  await expect(asleep).toBeVisible()
  await expect(treeRowOf(page, 'src').getByRole('img', { name: 'Contains changes' })).toBeVisible()
  await treeRowOf(page, 'README.md').click()
  await expect(tabPanelOf(page)).toContainText('This file cannot be read now')
  await tabPanelOf(page).getByRole('button', { name: 'All files' }).click()
  await asleep.getByRole('button', { name: 'Wake' }).click()
  await expect(asleep).toHaveCount(0, { timeout: 30_000 })
  await treeRowOf(page, 'README.md').click()
  await expect(tabPanelOf(page).getByRole('region', { name: 'README.md' }).locator('code')).toHaveText('# acme app')
})

test('a slow .hq/setup.sh no longer holds the session start: the agent answers while the setup output streams into its conversation step', {
  tag: ['@spec-40', '@slow'],
}, async ({ page }) => {
  await configureGitHubApp(page)
  await newDevChat(page, 'Docs setup', 'acme/docs')
  await sendMessage(page, 'stub:ls')
  await expect(messageContaining(page, 'files:.git,.hq,README.md')).toHaveCount(1)
  const setup = await openCommandStep(page, 'sh .hq/setup.sh')
  await expect(setup.locator('pre')).toContainText('installing the docs toolchain')
  await expect(setup).not.toContainText('exit 127')
  await expect(setup.locator('pre')).toContainText('docs-tool: command not found')
  await expect(setup).toContainText('exit 127')
  await expect(messageContaining(page, 'The setup script .hq/setup.sh failed with exit code 127')).toHaveCount(1)
})
