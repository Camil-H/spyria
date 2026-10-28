import { jobs } from '@spyria/db/postgres'
import { openPageAs, type WorkerStack } from '../stack'
import {
  addParticipant,
  agentReplyText,
  alicesWelcomeMessage,
  chatAction,
  chatLinkOf,
  chooseRunsOn,
  composerOf,
  expect,
  expectMembers,
  type Locator,
  mainOf,
  messageActionOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openPanelTab,
  openWelcome,
  type Page,
  quotedTime,
  repliesOf,
  replyBoxOf,
  replyInThread,
  sendButtonOf,
  sendMessage,
  sidebarOf,
  test,
  threadToggleOf,
  workingIndicatorOf,
} from './fixtures'

const bobsReply = 'Count me in for lunch'
const alicesReply = 'See you at noon'
const runtimeName = bobsReply
const startRuntime = async (message: Locator) =>
  (await messageActionOf(message, 'Start runtime from this message')).click()
const openMessageAction = async (page: Page, messageText: string, actionName: string) =>
  (await messageActionOf(messageContaining(page, messageText), actionName)).click()
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
  await startRuntime(repliesOf(page).filter({ hasText: bobsReply }))
  await expect(mainOf(page).getByRole('heading', { level: 1, name: runtimeName })).toBeVisible()
}

test.describe('Runtime from a thread', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I start a runtime from a thread reply: it opens with the whole thread in its first message and links back to its channel', {
    tag: ['@spec-32', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
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
      { useInnerText: true },
    )
    await expect(mainOf(page).getByRole('link', { name: 'Started from Welcome' })).toBeVisible()
    await bobPage.context().close()
  })

  test('As a thread author, I get the runtime chat started from my thread as a Reader', { tag: ['@spec-32'] }, async ({
    page,
    browser,
    workerStack,
  }) => {
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

  test('As a channel member, I follow the thread root’s link to its runtime, while a member who cannot read the runtime only sees who started it', {
    tag: ['@spec-32'],
  }, async ({ page, browser, workerStack }) => {
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

  test('As a member, I start a runtime from my own message without replies: it carries that message alone and adds nobody', {
    tag: ['@spec-32'],
  }, async ({ page }) => {
    await openWelcome(page)
    await sendMessage(page, 'Lunch at noon?')
    await startRuntime(messageContaining(page, 'Lunch at noon?'))
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Lunch at noon?' })).toBeVisible()
    await expect(messageItemsOf(page)).toHaveCount(1)
    await expect(messageItemsOf(page).nth(0)).toContainText(
      new RegExp(
        `Conversation so far, from the channel thread in #Welcome:\\n\\nAlice \\(member, human\\) · ${quotedTime}\\nLunch at noon\\?$`,
      ),
      { useInnerText: true },
    )
    await openPanelTab(page, 'Lunch at noon?', 'Members')
    await expectMembers(page, [['Alice', 'Owner']])
  })

  test('As a member, I copy a thread as context: the clipboard holds its channel and its messages quoted with their authors and times', {
    tag: ['@spec-32'],
  }, async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openWelcome(page)
    await replyInThread(page, alicesReply)
    const welcomeMessage = messageContaining(page, alicesWelcomeMessage).first()
    await (await messageActionOf(welcomeMessage, 'Copy thread as context')).click()
    await expect(await messageActionOf(welcomeMessage, 'Copied')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      new RegExp(
        `^${[
          'Conversation from channel thread in #Welcome',
          `Alice \\(member, human\\) · ${quotedTime}\\n${alicesWelcomeMessage.replace('.', '\\.')}`,
          `Alice \\(member, human\\) · ${quotedTime}\\n${alicesReply}`,
        ].join('\\n\\n')}$`,
      ),
    )
    await expect(await messageActionOf(repliesOf(page).first(), 'Copy thread as context')).toBeVisible()
  })

  test('As a member, I create a runtime from a thread without prompting the agent, and my first prompt after Runs on is answered', {
    tag: ['@spec-32'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await startRuntimeFromThread(page, bobPage)
    await chooseRunsOn(page, 'Spyria runtime')
    expect(await agentPromptJobs(workerStack)).toEqual([])
    await sendMessage(page, 'Summarise the thread.')
    await expect(messageContaining(page, agentReplyText)).toBeVisible({ timeout: 30_000 })
    expect(await agentPromptJobs(workerStack)).toHaveLength(1)
    await bobPage.context().close()
  })

  test('As a member, I start a runtime chat from a channel message: seeded, in the same project, linked back to its channel, with nothing sent to the agent', async ({
    page,
    workerStack,
  }) => {
    await test.step('creates a runtime chat in the same project, seeded, selected and focused', async () => {
      await openChat(page, 'Welcome')
      await openMessageAction(page, 'Thanks, glad to be here.', 'Start runtime from this message')
      const onboardingGroup = sidebarOf(page).getByRole('group', { name: 'Onboarding' })
      await expect(onboardingGroup.getByRole('link', { name: 'Thanks, glad to be here.' })).toBeVisible()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Thanks, glad to be here.' })).toBeVisible()
      await expect(composerOf(page)).toBeFocused()
      await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Runtime view')
      await expect(mainOf(page)).toContainText('Agent acts as Alice')
      await expect(mainOf(page)).toContainText('Model chosen at first prompt')
      await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toHaveCount(0)
      await expect(messageItemsOf(page).nth(0)).toContainText('Thanks, glad to be here.')
    })

    await test.step('links back to the source channel and sends nothing to the agent', async () => {
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect
        .poll(
          async () =>
            (
              await workerStack.database
                .$client`select chat_id from runtime_origins where message_id = 'message-welcome-2'`
            ).length,
        )
        .toBe(1)
      expect(await agentPromptJobs(workerStack)).toEqual([])
      await expect(messageContaining(page, agentReplyText)).toHaveCount(0)
      await mainOf(page).getByRole('link', { name: 'Started from Welcome' }).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
      await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Channel view')
    })

    await test.step('shows the new name in the started-from link of a runtime chat', async () => {
      await openChat(page, 'Thanks, glad to be here.')
      await expect(mainOf(page).getByRole('link', { name: 'Started from Welcome' })).toBeVisible()
      await chatAction(page, 'Welcome', 'Rename chat')
      await page.getByRole('textbox', { name: 'Chat name' }).fill('Greetings')
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(mainOf(page).getByRole('link', { name: 'Started from Greetings' })).toBeVisible()
    })

    await test.step('creates a loose runtime chat from a message of a loose channel', async () => {
      await openChat(page, 'Standup')
      await openMessageAction(page, 'Standup at 10.', 'Start runtime from this message')
      const looseChatsGroup = sidebarOf(page).getByRole('group', { name: 'Loose chats' })
      await expect(looseChatsGroup.getByRole('link', { name: 'Standup at 10.' })).toBeVisible()
      await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Runtime view')
    })
  })
})
