import { createHmac } from 'node:crypto'
import { openPageAs, type WorkerStack } from '../stack'
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
  toastOf,
  workingIndicatorOf,
} from './fixtures'

type AgentScript = (chatId: string, script: object) => Promise<void>

const webhookSecret = 'e2e-webhook-secret'
const commitCommand = (subject: string) =>
  `git add -A && git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qm '${subject}'`
const cardOf = (page: Page) => messageItemsOf(page).getByRole('region', { name: 'Pull request #1' })
const chipOf = (page: Page, state: string) => mainOf(page).getByRole('link', { name: `PR #1 · ${state}` })
const finished = (page: Page) => expect(workingIndicatorOf(page)).toHaveCount(0)
const pushButtonOf = (page: Page) => tabPanelOf(page).getByRole('button', { name: 'Push', exact: true })

const headShaOf = async (workerStack: WorkerStack, chatId: string) => {
  const [{ git_branch: branch } = {}] = await workerStack.database
    .$client`select git_branch from chats where id = ${chatId}`
  const query = new URLSearchParams({ db: workerStack.databaseName, repository: 'acme/app', branch: String(branch) })
  const { headSha } = (await (await fetch(`${serverUrl}/test/github?${query}`)).json()) as { headSha: string }
  return headSha
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
  return { chatId, headSha: await headShaOf(workerStack, chatId) }
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

test.describe('Pull requests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a chat owner, I push the agent’s commit and open a pull request: the card and the header chip show it', {
    tag: ['@spec-41', '@smoke'],
  }, async ({ page, agentScript }) => {
    await configureGitHubApp(page)
    await connectGitHub(page)
    await devChatWithCommit(page, agentScript, 'Publish totals')
    await panelTabOf(page, 'Changes').click()
    await pushButtonOf(page).click()
    await expect(toastOf(page).getByRole('status')).toContainText(/^Pushed spyria\/publish-totals-/)
    await openPullRequest(page)
    const card = cardOf(page)
    await expect(card).toContainText('Fix the totals')
    await expect(card).toContainText('#1')
    await expect(card).toContainText('open')
    await expect(card).toContainText('Checks pending')
    await expect(card).toContainText('1 commit')
    await expect(chipOf(page, 'open')).toBeVisible()
    await expect(tabPanelOf(page).getByRole('button', { name: 'Open pull request' })).toHaveCount(0)
  })

  test('As a prompter without a GitHub account, my agent’s push asks me, and only me, to connect GitHub, and once my role reads GitHub only I have no Push or Open pull request', {
    tag: ['@spec-41'],
  }, async ({ page, browser, agentScript, workerStack }) => {
    await configureGitHubApp(page)
    await connectGitHub(page)
    const chatId = await devChatWithCommit(page, agentScript, 'Guest push')
    await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Mistral')
    await openChat(bobPage, 'Guest push')
    await agentScript(chatId, { steps: [{ tool: 'push_branch' }], text: 'Connect GitHub first.' })
    await sendMessage(bobPage, 'Push the branch')
    await expect(messageContaining(bobPage, 'Connect GitHub first.')).toHaveCount(1)
    await finished(bobPage)

    await test.step('names me to connect GitHub, with the link for me only', async () => {
      await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Connect GitHub' })).toBeVisible()
      await expect(messageContaining(page, 'Bob needs to connect GitHub').first()).toBeVisible()
      await expect(messageItemsOf(page).getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0)
    })

    await test.step('offers me Push, which asks me to connect my own account, not the owner’s', async () => {
      await panelTabOf(bobPage, 'Changes').click()
      await expect(tabPanelOf(bobPage).getByRole('button', { name: /^src\/app\.ts/ })).toBeVisible()
      await pushButtonOf(bobPage).click()
      await expect(toastOf(bobPage).getByRole('alert')).toHaveText(
        'Connect your GitHub account in your profile to push',
      )
    })

    await test.step('once my role reads GitHub only, I have no Push or Open pull request', async () => {
      await workerStack.database.$client`
        insert into connection_access (workspace_id, connection_id, role_id, level, tool_changes)
        values ('workspace-acme', 'github', 'member', 'read', '{}')`
      await bobPage.reload()
      await panelTabOf(bobPage, 'Changes').click()
      await expect(tabPanelOf(bobPage).getByRole('button', { name: /^src\/app\.ts/ })).toBeVisible()
      await expect(pushButtonOf(bobPage)).toHaveCount(0)
      await expect(tabPanelOf(bobPage).getByRole('button', { name: 'Open pull request' })).toHaveCount(0)
    })
    await bobPage.context().close()
  })

  test('As a chat owner, I see signed webhooks turn the checks to passing, show the requested changes with their comments, then turn the card and the header chip to merged', {
    tag: ['@spec-41'],
  }, async ({ page, agentScript, workerStack }) => {
    const { headSha } = await openedPullRequest(page, agentScript, workerStack, 'Checked totals')
    const suite = {
      action: 'completed',
      check_suite: { id: 7, head_sha: headSha, conclusion: 'success', pull_requests: [{ number: 1 }] },
    }
    await expect(cardOf(page)).toContainText('Checks pending')
    await expect(chipOf(page, 'open')).toBeVisible()
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

    expect(
      await sendWebhook(workerStack, 'pull_request', {
        action: 'closed',
        pull_request: {
          number: 1,
          html_url: 'https://github.test/acme/app/pull/1',
          title: 'Fix the totals',
          head: { sha: headSha },
          state: 'closed',
          merged: true,
          commits: 1,
        },
      }),
    ).toBe(200)
    await expect(card).toContainText('merged')
    await expect(chipOf(page, 'merged')).toBeVisible()
  })

  test('As a chat owner, I address review comments: the agent is prompted with both, and after its edit I push and the card counts the new commit', {
    tag: ['@spec-41'],
  }, async ({ page, agentScript, workerStack }) => {
    const { chatId, headSha } = await openedPullRequest(page, agentScript, workerStack, 'Reviewed totals')
    await reviewWithComments(workerStack, headSha)
    await agentScript(chatId, {
      steps: [
        {
          edit: { path: 'src/app.ts', oldText: 'export const total = 2\n', newText: 'export const invoiceTotal = 2\n' },
        },
        { command: commitCommand('Address the review') },
      ],
      text: 'Addressed the review.',
    })
    await expect(cardOf(page).getByRole('list', { name: 'Review comments' }).getByRole('listitem')).toHaveCount(2)
    await cardOf(page).getByRole('button', { name: 'Address review comments' }).click()
    const prompt = messageContaining(page, 'Address the review comments on pull request #1, then commit:')
    await expect(prompt.getByRole('listitem')).toHaveText([
      'src/app.ts:1 (rita): Name this total',
      'src/app.ts:1 (rita): Add a test for the totals',
    ])
    await expect(messageContaining(page, 'Addressed the review.')).toHaveCount(1)
    await finished(page)
    await panelTabOf(page, 'Changes').click()
    await pushButtonOf(page).click()
    await expect(toastOf(page).getByRole('status')).toContainText('to pull request #1 (2 commits)')
    await expect(cardOf(page)).toContainText('2 commits')
  })
})
