import { jobs } from '@hq/db/postgres'
import {
  addParticipant,
  agentReplyText,
  alicesWelcomeMessage,
  chatLinkOf,
  chooseRunsOn,
  expect,
  expectMembers,
  type Locator,
  mainOf,
  messageContaining,
  messageItemsOf,
  openMessageMenu,
  openPanelTab,
  openWelcome,
  type Page,
  quotedTime,
  repliesOf,
  replyBoxOf,
  replyInThread,
  sendButtonOf,
  sendMessage,
  test,
  threadToggleOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const bobsReply = 'Count me in for lunch'
const alicesReply = 'See you at noon'
const runtimeName = bobsReply
const startRuntime = async (page: Page, message: Locator) => {
  await openMessageMenu(message)
  await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()
}
const agentPromptJobs = async (workerStack: WorkerStack) =>
  (await workerStack.database.select().from(jobs)).filter((job) => job.type === 'agent.prompt')
const runtimeLinkOf = (page: Page) =>
  messageContaining(page, alicesWelcomeMessage)
    .first()
    .getByRole('link', { name: /^Runtime: / })

const startRuntimeFromThread = async (page: Page, bobPage: Page) => {
  await openWelcome(page)
  await openWelcome(bobPage)
  await replyInThread(bobPage, bobsReply)
  await threadToggleOf(page).click()
  await expect(repliesOf(page)).toHaveText([new RegExp(bobsReply)])
  await replyBoxOf(page).fill(alicesReply)
  await replyBoxOf(page).press('ControlOrMeta+Enter')
  await expect(repliesOf(page)).toHaveCount(2)
  await startRuntime(page, repliesOf(page).filter({ hasText: bobsReply }))
  await expect(mainOf(page).getByRole('heading', { level: 1, name: runtimeName })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('32-1. a runtime started from a thread reply opens with the whole thread in its first message and its origin Welcome', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await startRuntimeFromThread(page, bobPage)
  await expect(messageItemsOf(page).nth(0)).toContainText(
    new RegExp(
      [
        'Conversation so far, from the channel thread in #Welcome:',
        `Alice \\(member, human\\) · 2026-09-30 09:02 UTC\\n${alicesWelcomeMessage.replace('.', '\\.')}`,
        `Bob \\(member, human\\) · ${quotedTime}\\n${bobsReply}`,
        `Alice \\(member, human\\) · ${quotedTime}\\n${alicesReply}`,
      ].join('\\n\\n'),
    ),
  )
  await expect(mainOf(page).getByRole('link', { name: 'Started from Welcome' })).toBeVisible()
  await bobPage.context().close()
})

test('32-2. Bob, a thread author, gets the runtime chat as a Reader', async ({ page, browser, workerStack }) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await startRuntimeFromThread(page, bobPage)
  await expect(chatLinkOf(bobPage, runtimeName)).toBeVisible()
  await openPanelTab(bobPage, runtimeName, 'Members')
  await expect(mainOf(bobPage)).toContainText('You can read this chat')
  await expect(sendButtonOf(bobPage)).toBeDisabled()
  await expectMembers(bobPage, [
    ['Alice', 'Owner'],
    ['Bob', 'Reader'],
  ])
  await bobPage.context().close()
})

test('32-3. the thread root links to the runtime for Alice and Bob; Lee, who cannot read it, sees who started it', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addParticipant(workerStack, 'chat-welcome', 'member-lee', 'reader')
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await startRuntimeFromThread(page, bobPage)
  await openWelcome(leePage)
  await openWelcome(page)
  await expect(runtimeLinkOf(bobPage)).toHaveText(`Runtime: ${runtimeName}`)
  await expect(messageContaining(leePage, alicesWelcomeMessage).first()).toContainText('Alice started a runtime')
  await expect(runtimeLinkOf(leePage)).toHaveCount(0)
  await runtimeLinkOf(page).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: runtimeName })).toBeVisible()
  await bobPage.context().close()
  await leePage.context().close()
})

test('32-4. a runtime started from an own top-level message without replies carries it alone and adds nobody', async ({
  page,
}) => {
  await openWelcome(page)
  await sendMessage(page, 'Lunch at noon?')
  await startRuntime(page, messageContaining(page, 'Lunch at noon?'))
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Lunch at noon?' })).toBeVisible()
  await expect(messageItemsOf(page)).toHaveCount(1)
  await expect(messageItemsOf(page).nth(0)).toContainText(
    new RegExp(
      `Conversation so far, from the channel thread in #Welcome:\\n\\nAlice \\(member, human\\) · ${quotedTime}\\nLunch at noon\\?$`,
    ),
  )
  await openPanelTab(page, 'Lunch at noon?', 'Members')
  await expectMembers(page, [['Alice', 'Owner']])
})

test('32-5. creating the runtime sends nothing to the agent; Alice’s first prompt after Runs on is answered', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await startRuntimeFromThread(page, bobPage)
  await chooseRunsOn(page, 'HQ runtime')
  expect(await agentPromptJobs(workerStack)).toEqual([])
  await sendMessage(page, 'Summarise the thread.')
  await expect(messageContaining(page, agentReplyText)).toBeVisible({ timeout: 30_000 })
  expect(await agentPromptJobs(workerStack)).toHaveLength(1)
  await bobPage.context().close()
})
