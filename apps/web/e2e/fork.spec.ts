import {
  addLlmKey,
  addParticipant,
  chatLinkOf,
  chooseRunsOn,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  mutationGateOf,
  newRuntimeChat,
  openChat,
  type Page,
  quotedTime,
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { type AgentScript, openPageAs, type WorkerStack } from './stack'

const forkName = 'Research (fork)'
const forkButtonOf = (page: Page) => mainOf(page).getByRole('button', { name: 'Fork into my session' })

const researchWithHistory = async (
  page: Page,
  workerStack: WorkerStack,
  agentScript: (chatId: string, script: AgentScript) => Promise<void>,
) => {
  await agentScript(research, { steps: [{ tool: 'crm-lookup' }], text: 'Found it.' })
  await sendMessage(page, 'Find the bug.')
  await expect(messageContaining(page, 'Found it.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await workerStack.database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at, deleted_at)
    select 'workspace-acme', ${research}, 'message-deleted-before-fork', max(seq) + 1, 'member', 'member-alice', '',
      now(), now()
    from messages where chat_id = ${research}`
  await expect(messageContaining(page, 'This message was deleted')).toHaveCount(1)
  await addParticipant(workerStack, research, 'member-bob', 'reader')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Research')
})

test('34-1. a Reader forks a runtime chat into a private chat of his own, seeded with its member and agent messages', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  await researchWithHistory(page, workerStack, agentScript)
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Research')
  await forkButtonOf(bobPage).click()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: forkName })).toBeVisible()
  await expect(mainOf(bobPage).getByRole('link', { name: 'Forked from Research' })).toBeVisible()
  await expect(messageItemsOf(bobPage)).toHaveCount(1)
  await expect(messageItemsOf(bobPage).nth(0)).toContainText(
    new RegExp(
      [
        'Conversation so far, from the runtime chat Research:',
        `Alice \\(member, human\\) · ${quotedTime}\\nFind the bug\\.`,
        `Agent \\(agent\\) · ${quotedTime}\\nFound it\\.$`,
      ].join('\\n\\n'),
    ),
  )
  await expect(messageItemsOf(bobPage).nth(0)).not.toContainText('lookup')
  await bobPage.context().close()
})

test('34-2 and 34-3. the forker chooses Runs on and gets a reply; the source is unchanged and the fork stays out of the owner’s sidebar', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  await researchWithHistory(page, workerStack, agentScript)
  const sourceMessages = await messageItemsOf(page).allTextContents()
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Research')
  await forkButtonOf(bobPage).click()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: forkName })).toBeVisible()
  await chooseRunsOn(bobPage, 'HQ runtime')
  await agentScript(bobPage.url().split('/').at(-1) ?? '', { text: 'Fixed on Bob’s session.' })
  await sendMessage(bobPage, 'Fix it.')
  await expect(messageContaining(bobPage, 'Fixed on Bob’s session.')).toHaveCount(1, { timeout: 30_000 })
  await expect(chatLinkOf(bobPage, forkName)).toBeVisible()

  await expect(messageItemsOf(page)).toHaveText(sourceMessages)
  await expect(chatLinkOf(page, 'Research')).toBeVisible()
  await expect(chatLinkOf(page, forkName)).toHaveCount(0)
  await bobPage.context().close()
})

test('34-4. an invitee whose keys cannot reach the session’s model forks from the notice', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake-small')
  const chatId = await newRuntimeChat(page, 'Alice large')
  await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
  await agentScript(chatId, { route: { tier: 'large', confidence: 'high', effort: 'high' } })
  await sendMessage(page, 'Redesign everything')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await openChat(bobPage, 'Alice large')
  await sendMessage(bobPage, 'Bob joins the large session')
  const notice = messageContaining(bobPage, 'Your keys cannot reach Fake large; switch the model or add a key')
  await expect(notice).toBeVisible()
  await expect(messageContaining(page, 'Your keys cannot reach Fake large')).toBeVisible()
  await expect(forkButtonOf(page)).toHaveCount(1)
  await notice.getByRole('button', { name: 'Fork into my session' }).click()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Alice large (fork)' })).toBeVisible()
  await expect(mainOf(bobPage).getByRole('link', { name: 'Forked from Alice large' })).toBeVisible()
  await expect(messageItemsOf(bobPage).nth(0)).toContainText('Bob joins the large session')
  await bobPage.context().close()
})

test('35-1. a double click on Fork creates exactly one fork; the button reads Forking… until the server confirms', async ({
  browser,
  workerStack,
}) => {
  await addParticipant(workerStack, research, 'member-bob', 'reader')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  const gate = await mutationGateOf(bobPage)
  await openChat(bobPage, 'Research')
  gate.hold()
  await forkButtonOf(bobPage).dblclick()
  const pendingFork = mainOf(bobPage).getByRole('button', { name: 'Forking…' })
  await expect(pendingFork).toBeDisabled()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
  gate.release()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: forkName })).toBeVisible()
  await expect(chatLinkOf(bobPage, forkName)).toHaveCount(1)
  expect(await workerStack.database.$client`select id from chats where name = ${forkName}`).toHaveLength(1)
  await bobPage.context().close()
})
