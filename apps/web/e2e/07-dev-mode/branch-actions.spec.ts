import { openPageAs } from '../stack'
import {
  addParticipant,
  configureGitHubApp,
  connectGitHub,
  expect,
  messageContaining,
  newDevChat,
  openChat,
  type Page,
  panelTabOf,
  sendMessage,
  serverUrl,
  tabPanelOf,
  test,
  workingIndicatorOf,
} from './fixtures'

type AgentScript = (chatId: string, script: object) => Promise<void>

const commitCommand = (subject: string) =>
  `git add -A && git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qm '${subject}'`
const appEdit = (from: number, to: number) => ({
  edit: { path: 'src/app.ts', oldText: `export const total = ${from}\n`, newText: `export const total = ${to}\n` },
})
const finished = (page: Page) => expect(workingIndicatorOf(page)).toHaveCount(0)
const statusLineOf = (page: Page) => tabPanelOf(page).getByRole('region', { name: 'Branch status' })
const headerButtonOf = (page: Page, name: string) => tabPanelOf(page).getByRole('button', { name, exact: true })
const diffOf = (page: Page, path: string) => tabPanelOf(page).getByRole('table', { name: `Diff of ${path}` })

const runAgent = async (page: Page, agentScript: AgentScript, chatId: string, steps: object[], text: string) => {
  await agentScript(chatId, { steps, text })
  await sendMessage(page, text.replace(/\.$/, ''))
  await expect(messageContaining(page, text)).toHaveCount(1)
  await finished(page)
}
const newBaseBranch = async () => {
  const branch = `e2e-base-${crypto.randomUUID().slice(0, 8)}`
  await commitToBase(branch, { [`docs/${branch}.md`]: 'base\n' }, 'Start the base')
  return branch
}
const commitToBase = (branch: string, files: Record<string, string>, message: string) =>
  fetch(`${serverUrl}/test/github-commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repository: 'acme/app', branch, files, message }),
  })
const devChatWithCommit = async (page: Page, agentScript: AgentScript, name: string, baseBranch = 'main') => {
  const chatId = await newDevChat(page, name, 'acme/app', baseBranch)
  await runAgent(page, agentScript, chatId, [appEdit(1, 2), { command: commitCommand('Fix the totals') }], 'Fixed.')
  await panelTabOf(page, 'Changes').click()
  return chatId
}

test.describe('Branch actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a chat owner, I read the working branch and its base, the commits ahead of the base and the uncommitted files in the status line', {
    tag: ['@spec-43'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    const chatId = await devChatWithCommit(page, agentScript, 'Status totals')
    const statusLine = statusLineOf(page)
    await expect(statusLine).toContainText(/hq\/status-totals-\w+ → main/)
    await expect(statusLine).toContainText('1 ahead of main')
    await expect(statusLine).toContainText('No uncommitted files')
    await runAgent(
      page,
      agentScript,
      chatId,
      [appEdit(2, 3), { edit: { path: 'src/new.ts', create: 'export const added = true\n' } }],
      'Edited two files.',
    )
    await expect(statusLine).toContainText('2 files uncommitted')
    await expect(statusLine).toContainText('1 ahead of main')
  })

  test('As a chat owner, I commit with a message under my name: Commits lists it, and the status line shows nothing uncommitted and one commit ahead of the pushed branch', {
    tag: ['@spec-43', '@smoke'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    await connectGitHub(page)
    const chatId = await devChatWithCommit(page, agentScript, 'Commit totals')
    await headerButtonOf(page, 'Push').click()
    await expect(tabPanelOf(page).getByRole('status')).toContainText(/^Pushed hq\/commit-totals-/)
    const statusLine = statusLineOf(page)
    await expect(statusLine).toContainText('Pushed branch up to date')
    await expect(statusLine).toContainText('Last push')
    await runAgent(page, agentScript, chatId, [appEdit(2, 3)], 'Raised the total.')
    await expect(statusLine).toContainText('1 file uncommitted')

    await headerButtonOf(page, 'Commit').click()
    const form = tabPanelOf(page).getByRole('form', { name: 'Commit changes' })
    await expect(form.getByRole('button', { name: 'Commit' })).toBeDisabled()
    await form.getByLabel('Commit message').fill('Raise the total')
    await form.getByRole('button', { name: 'Commit' }).click()
    await expect(
      tabPanelOf(page)
        .getByRole('status')
        .filter({ hasText: /^Committed [0-9a-f]{7}$/ }),
    ).toBeVisible()
    await expect(form).toHaveCount(0)
    await expect(statusLine).toContainText('No uncommitted files')
    await expect(statusLine).toContainText('1 ahead of the pushed branch')
    await expect(statusLine).toContainText('2 ahead of main')

    await panelTabOf(page, 'Commits').click()
    const commits = tabPanelOf(page).getByRole('listitem')
    await expect(commits).toHaveCount(2)
    await expect(commits.first()).toContainText('Raise the total')
    await expect(commits.first()).toContainText(/Alice Martin · \d\d:\d\d UTC/)
  })

  test('As a chat owner, I merge a new base commit with Update from base: the status line counts the merge, Commits shows it and Files shows the base’s new file', {
    tag: ['@spec-43'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    const baseBranch = await newBaseBranch()
    await devChatWithCommit(page, agentScript, 'Update totals', baseBranch)
    const statusLine = statusLineOf(page)
    await expect(statusLine).toContainText(`1 ahead of ${baseBranch}`)
    await commitToBase(baseBranch, { 'docs/from-base.md': 'from base\n' }, 'Add the base docs')

    await headerButtonOf(page, 'Update from base').click()
    await expect(
      tabPanelOf(page)
        .getByRole('status')
        .filter({ hasText: `Merged ${baseBranch}` }),
    ).toBeVisible()
    await expect(statusLine).toContainText(`2 ahead of ${baseBranch}`)
    await expect(statusLine).not.toContainText('behind')
    await expect(tabPanelOf(page).getByRole('region', { name: 'Changes in docs/from-base.md' })).toHaveCount(0)

    await panelTabOf(page, 'Commits').click()
    await expect(tabPanelOf(page).getByRole('listitem').first()).toContainText(
      new RegExp(`Merge branch '${baseBranch}' into hq/update-totals-`),
    )
    await panelTabOf(page, 'Files').click()
    await tabPanelOf(page).getByRole('button', { name: 'docs', exact: false }).click()
    await expect(tabPanelOf(page).getByRole('button', { name: 'from-base.md', exact: false })).toBeVisible()
  })

  test('As a chat owner, I see Update from base report a conflict with a clean working copy, and Ask the agent to resolve conflicts prompts it as me with the files', {
    tag: ['@spec-43'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    const baseBranch = await newBaseBranch()
    const chatId = await devChatWithCommit(page, agentScript, 'Conflicting totals', baseBranch)
    await commitToBase(baseBranch, { 'src/app.ts': 'export const total = 3\n' }, 'Raise the total on the base')

    await headerButtonOf(page, 'Update from base').click()
    await expect(tabPanelOf(page).getByRole('alert')).toHaveText(
      `Updating from ${baseBranch} conflicts in src/app.ts; the merge was aborted`,
    )
    const statusLine = statusLineOf(page)
    await expect(statusLine).toContainText('No uncommitted files')
    await expect(statusLine).toContainText(`1 behind ${baseBranch}`)

    await agentScript(chatId, { steps: [], text: 'Resolved the conflicts.' })
    await tabPanelOf(page).getByRole('button', { name: 'Ask the agent to resolve conflicts' }).click()
    const prompt = messageContaining(page, `Merge the latest ${baseBranch} (fetched as refs/hq/base)`)
    await expect(prompt).toHaveCount(1)
    await expect(prompt).toContainText('Alice')
    await expect(prompt).toContainText('- src/app.ts')
    await expect(messageContaining(page, 'Resolved the conflicts.')).toHaveCount(1)
    await expect(tabPanelOf(page).getByRole('status').filter({ hasText: 'Asked the agent' })).toBeVisible()
  })

  test('As a prompter, I see the status line and the diff but neither Commit nor Update from base', {
    tag: ['@spec-43'],
  }, async ({ page, browser, agentScript, workerStack }) => {
    await configureGitHubApp(page)
    const chatId = await devChatWithCommit(page, agentScript, 'Prompter totals')
    await expect(headerButtonOf(page, 'Commit')).toBeVisible()
    await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Prompter totals')
    await panelTabOf(bobPage, 'Changes').click()
    await expect(statusLineOf(bobPage)).toContainText('1 ahead of main')
    await expect(diffOf(bobPage, 'src/app.ts')).toBeVisible()
    await expect(headerButtonOf(bobPage, 'Commit')).toHaveCount(0)
    await expect(headerButtonOf(bobPage, 'Update from base')).toHaveCount(0)
    await expect(headerButtonOf(bobPage, 'Refresh')).toBeVisible()
  })
})
