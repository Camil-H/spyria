import { createHmac } from 'node:crypto'
import {
  addLlmKey,
  addParticipant,
  configureGitHubApp,
  connectGitHub,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
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
import { openPageAs, type WorkerStack } from './stack'

type AgentScript = (chatId: string, script: object) => Promise<void>

const webhookSecret = 'e2e-webhook-secret'
const commitCommand = (subject: string) =>
  `git add -A && git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qm '${subject}'`
const cardOf = (page: Page) => messageItemsOf(page).getByRole('region', { name: 'Pull request #1' })
const chipOf = (page: Page, state: string) => mainOf(page).getByRole('link', { name: `PR #1 · ${state}` })
const finished = (page: Page) => expect(workingIndicatorOf(page)).toHaveCount(0)
const pushButtonOf = (page: Page) => tabPanelOf(page).getByRole('button', { name: 'Push', exact: true })

const githubStateOf = async (workerStack: WorkerStack, chatId: string) => {
  const [{ git_branch: branch } = {}] = await workerStack.database
    .$client`select git_branch from chats where id = ${chatId}`
  const query = new URLSearchParams({ db: workerStack.databaseName, repository: 'acme/app', branch: String(branch) })
  return (await (await fetch(`${serverUrl}/test/github?${query}`)).json()) as {
    commits: string[]
    headSha: string
    pullRequests: { number: number; title: string; authorId: string | null }[]
  }
}
const sendWebhook = async (workerStack: WorkerStack, event: string, payload: object, secret = webhookSecret) => {
  const { appId = '' } = (await (await fetch(`${serverUrl}/test/github-app`)).json()) as { appId?: string }
  const body = JSON.stringify({ repository: { full_name: 'acme/app' }, ...payload })
  const response = await fetch(`${serverUrl}/api/github/webhooks?db=${workerStack.databaseName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': crypto.randomUUID(),
      'x-github-hook-installation-target-id': appId,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  })
  return response.status
}
const devChatWithCommit = async (page: Page, agentScript: AgentScript, name: string) => {
  const chatId = await newDevChat(page, name, 'acme/app')
  await agentScript(chatId, {
    steps: [
      { edit: { path: 'src/app.ts', oldText: 'export const total = 1\n', newText: 'export const total = 2\n' } },
      { command: commitCommand('Fix the totals') },
    ],
    text: 'Committed the fix.',
  })
  await sendMessage(page, 'Fix the totals and commit')
  await expect(messageContaining(page, 'Committed the fix.')).toHaveCount(1)
  await finished(page)
  return chatId
}
const openPullRequest = async (page: Page) => {
  await panelTabOf(page, 'Changes').click()
  await expect(tabPanelOf(page).getByRole('button', { name: /^src\/app\.ts/ })).toBeVisible()
  await tabPanelOf(page).getByRole('button', { name: 'Open pull request' }).click()
  const form = tabPanelOf(page).getByRole('form', { name: 'Open pull request' })
  await expect(form.getByLabel('Description')).toHaveValue('- Fix the totals')
  await form.getByLabel('Title').fill('Fix the totals')
  await form.getByRole('button', { name: 'Create pull request' }).click()
  await expect(cardOf(page)).toBeVisible()
}
const openedPullRequest = async (page: Page, agentScript: AgentScript, workerStack: WorkerStack, name: string) => {
  await configureGitHubApp(page)
  await connectGitHub(page)
  const chatId = await devChatWithCommit(page, agentScript, name)
  await openPullRequest(page)
  return { chatId, headSha: (await githubStateOf(workerStack, chatId)).headSha }
}
const reviewWithComments = async (workerStack: WorkerStack, headSha: string) => {
  const pullRequest = {
    number: 1,
    html_url: 'https://github.test/acme/app/pull/1',
    title: 'Fix the totals',
    state: 'open',
    head: { sha: headSha },
  }
  await sendWebhook(workerStack, 'pull_request_review', {
    action: 'submitted',
    pull_request: pullRequest,
    review: { state: 'changes_requested' },
  })
  for (const [id, line, body] of [
    [41, 1, 'Name this total'],
    [42, 1, 'Add a test for the totals'],
  ] as const)
    await sendWebhook(workerStack, 'pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: { id, path: 'src/app.ts', line, user: { login: 'rita' }, body },
    })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('41-1. the owner pushes the agent’s commit and opens a pull request: the card and the header chip show it, authored with the owner’s token', async ({
  page,
  agentScript,
  workerStack,
}) => {
  await configureGitHubApp(page)
  await connectGitHub(page)
  const chatId = await devChatWithCommit(page, agentScript, 'Publish totals')
  await panelTabOf(page, 'Changes').click()
  await pushButtonOf(page).click()
  await expect(tabPanelOf(page).getByRole('status')).toContainText(/^Pushed hq\/publish-totals-/)
  expect((await githubStateOf(workerStack, chatId)).commits).toEqual(['Fix the totals'])
  await openPullRequest(page)
  const card = cardOf(page)
  await expect(card).toContainText('Fix the totals')
  await expect(card).toContainText('#1')
  await expect(card).toContainText('open')
  await expect(card).toContainText('Checks pending')
  await expect(card).toContainText('1 commit')
  await expect(chipOf(page, 'open')).toBeVisible()
  await expect(tabPanelOf(page).getByRole('button', { name: 'Open pull request' })).toHaveCount(0)
  expect((await githubStateOf(workerStack, chatId)).pullRequests).toEqual([
    expect.objectContaining({ number: 1, title: 'Fix the totals', authorId: 'member-alice' }),
  ])
})

test('41-2. a prompter’s request to push is refused to the agent with the owner-only notice, and the prompter has no Push or Open pull request', async ({
  page,
  browser,
  agentScript,
  workerStack,
}) => {
  await configureGitHubApp(page)
  await connectGitHub(page)
  const chatId = await devChatWithCommit(page, agentScript, 'Guest push')
  await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Guest push')
  await agentScript(chatId, { steps: [{ tool: 'push_branch' }], text: 'Only Alice can publish here.' })
  await sendMessage(bobPage, 'Push the branch')
  await expect(messageContaining(bobPage, 'Only Alice can publish here.')).toHaveCount(1)
  await finished(bobPage)
  await messageItemsOf(bobPage)
    .getByRole('button', { name: /^Used push_branch/ })
    .click()
  await expect(messageContaining(bobPage, 'Used push_branch')).toContainText(
    'Only Alice can push or open pull requests in this chat',
  )
  await panelTabOf(bobPage, 'Changes').click()
  await expect(tabPanelOf(bobPage).getByRole('button', { name: /^src\/app\.ts/ })).toBeVisible()
  await expect(pushButtonOf(bobPage)).toHaveCount(0)
  await expect(tabPanelOf(bobPage).getByRole('button', { name: 'Open pull request' })).toHaveCount(0)
  expect((await githubStateOf(workerStack, chatId)).commits).toEqual([])
  const [refusal] = await workerStack.database.$client`
    select prompter_id, tool, status from tool_calls where chat_id = ${chatId} and server = 'github'`
  expect(refusal).toEqual({ prompter_id: 'member-bob', tool: 'push_branch', status: 'refused' })
})

test('41-3. signed webhooks turn the checks to passing and show the requested changes with their comments; a bad signature changes nothing', async ({
  page,
  agentScript,
  workerStack,
}) => {
  const { headSha } = await openedPullRequest(page, agentScript, workerStack, 'Checked totals')
  const suite = {
    action: 'completed',
    check_suite: { id: 7, head_sha: headSha, conclusion: 'success', pull_requests: [{ number: 1 }] },
  }
  expect(await sendWebhook(workerStack, 'check_suite', suite, 'not-the-secret')).toBe(401)
  await expect(cardOf(page)).toContainText('Checks pending')
  expect(await sendWebhook(workerStack, 'check_suite', suite)).toBe(200)
  await expect(cardOf(page)).toContainText('Checks passing')
  await reviewWithComments(workerStack, headSha)
  const card = cardOf(page)
  await expect(card).toContainText('Changes requested')
  const comments = card.getByRole('list', { name: 'Review comments' }).getByRole('listitem')
  await expect(comments).toHaveText([
    'src/app.ts:1 rita: Name this total',
    'src/app.ts:1 rita: Add a test for the totals',
  ])
})

test('41-4. Address review comments prompts the agent with both comments; after its edit the owner pushes and the card counts the new commit', async ({
  page,
  agentScript,
  workerStack,
}) => {
  const { chatId, headSha } = await openedPullRequest(page, agentScript, workerStack, 'Reviewed totals')
  await reviewWithComments(workerStack, headSha)
  await agentScript(chatId, {
    steps: [
      { edit: { path: 'src/app.ts', oldText: 'export const total = 2\n', newText: 'export const invoiceTotal = 2\n' } },
      { command: commitCommand('Address the review') },
    ],
    text: 'Addressed the review.',
  })
  await expect(cardOf(page).getByRole('list', { name: 'Review comments' }).getByRole('listitem')).toHaveCount(2)
  await cardOf(page).getByRole('button', { name: 'Address review comments' }).click()
  const prompt = messageContaining(page, 'Address the review comments on pull request #1, then commit:')
  await expect(prompt).toContainText('- src/app.ts:1 (rita): Name this total')
  await expect(prompt).toContainText('- src/app.ts:1 (rita): Add a test for the totals')
  await expect(messageContaining(page, 'Addressed the review.')).toHaveCount(1)
  await finished(page)
  await panelTabOf(page, 'Changes').click()
  await pushButtonOf(page).click()
  await expect(tabPanelOf(page).getByRole('status')).toContainText('to pull request #1 (2 commits)')
  await expect(cardOf(page)).toContainText('2 commits')
  expect((await githubStateOf(workerStack, chatId)).commits).toEqual(['Address the review', 'Fix the totals'])
})

test('41-5. an owner without a GitHub connection is asked to connect it on Push', async ({ page, agentScript }) => {
  await configureGitHubApp(page)
  await devChatWithCommit(page, agentScript, 'Unconnected totals')
  await panelTabOf(page, 'Changes').click()
  await pushButtonOf(page).click()
  await expect(tabPanelOf(page).getByRole('alert')).toHaveText('Connect your GitHub account in your profile to push')
})

test('41-6. a merged pull_request webhook turns the card and the header chip to merged', async ({
  page,
  agentScript,
  workerStack,
}) => {
  const { headSha } = await openedPullRequest(page, agentScript, workerStack, 'Merged totals')
  await expect(chipOf(page, 'open')).toBeVisible()
  const pullRequest = {
    number: 1,
    html_url: 'https://github.test/acme/app/pull/1',
    title: 'Fix the totals',
    head: { sha: headSha },
  }
  expect(
    await sendWebhook(workerStack, 'pull_request', {
      action: 'closed',
      pull_request: { ...pullRequest, state: 'closed', merged: true, commits: 1 },
    }),
  ).toBe(200)
  await expect(cardOf(page)).toContainText('merged')
  await expect(chipOf(page, 'merged')).toBeVisible()
})
