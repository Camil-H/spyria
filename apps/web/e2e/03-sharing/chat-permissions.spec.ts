import { openPageAs } from '../stack'
import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chatLinkOf,
  composerOf,
  expect,
  expectMembers,
  insertRole,
  inviteRoleOptionsOf,
  type Locator,
  mainOf,
  messageContaining,
  messageItemsOf,
  modeRadioOf,
  newRuntimeChat,
  openChat,
  openPanelTab,
  openSession,
  type Page,
  projectAction,
  sendButtonOf,
  sendMessage,
  sessionOf,
  sidebarOf,
  panelTabOf as tabOf,
  test,
  workingIndicatorOf,
} from './fixtures'

test.describe('Chat permissions', () => {
  test.describe(() => {
    const dialogOf = (page: Page, dialogName: string) => page.getByRole('dialog', { name: dialogName })

    test.use({ runtimeHost: false, warmRuntimes: false })

    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

    test('As a chat owner, my private runtime chats never reach Bob, and a private chat URL shows him the not-found state', {
      tag: ['@spec-28', '@smoke'],
    }, async ({ page, browser, workerStack }) => {
      await newRuntimeChat(page, 'Alice only', null)
      const privateChatUrl = page.url()
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await expect(chatLinkOf(bobPage, 'Invoice bug')).toBeVisible()
      await expect(chatLinkOf(bobPage, 'Alice only')).toHaveCount(0)
      await expect(chatLinkOf(bobPage, 'Research')).toHaveCount(0)
      await bobPage.goto(privateChatUrl)
      await expect(mainOf(bobPage)).toContainText('Select a chat')
      await expect(mainOf(bobPage).getByRole('heading', { level: 1 })).toHaveCount(0)
      await bobPage.context().close()
    })

    test('As a member, I get Rename, Move and Archive only on chats I administer, and Archive with its chats only when I administer every chat of the project', {
      tag: ['@spec-28'],
    }, async ({ page, browser, workerStack }) => {
      await page.getByRole('button', { name: 'Chat actions for Invoice bug' }).click()
      for (const itemName of ['Rename chat', 'Move to', 'Archive chat'])
        await expect(page.getByRole('menuitem', { name: itemName })).toBeVisible()
      await page.keyboard.press('Escape')

      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await expect(chatLinkOf(bobPage, 'Invoice bug')).toBeVisible()
      await bobPage.getByRole('button', { name: 'Chat actions for Invoice bug' }).click()
      await expect(bobPage.getByRole('menuitem')).toHaveText(['Leave chat'])
      await bobPage.keyboard.press('Escape')
      await expect(bobPage.getByRole('button', { name: 'Chat actions for Standup' })).toHaveCount(1)
      await projectAction(bobPage, 'Billing', 'Archive project')
      await expect(
        dialogOf(bobPage, 'Archive project').getByRole('button', { name: 'Archive, keep chats' }),
      ).toBeVisible()
      await expect(
        dialogOf(bobPage, 'Archive project').getByRole('button', { name: 'Archive with its chats' }),
      ).toHaveCount(0)
      await bobPage.context().close()
    })
  })

  test.describe(() => {
    const openMessageMenu = async (message: Locator) => {
      await message.hover()
      await message.getByRole('button', { name: 'Message actions' }).click()
    }

    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-10-01T12:34:00Z'))
      await page.goto('/')
    })

    test('As a reader, I see a reply arrive live but cannot post, stop, or edit and delete messages', {
      tag: ['@spec-28'],
    }, async ({ page, browser, workerStack, agentScript, release }) => {
      const readerNotice = 'You can read this chat'
      const chatId = await newRuntimeChat(page, 'Lee reads')
      await addParticipant(workerStack, chatId, 'member-lee', 'reader')
      await addParticipant(workerStack, 'chat-welcome', 'member-lee', 'reader')
      const leePage = await openPageAs(browser, workerStack, 'member-lee')
      await openChat(leePage, 'Lee reads')
      await composerOf(leePage).fill('Lee would like to ask')
      await expect(sendButtonOf(leePage)).toBeDisabled()
      await expect(mainOf(leePage)).toContainText(readerNotice)

      await agentScript(chatId, { hold: 'answer' })
      await sendMessage(page, 'Alice asks while Lee reads')
      await expect(messageContaining(leePage, 'Alice asks while Lee reads')).toHaveCount(1)
      await expect(workingIndicatorOf(leePage)).toBeVisible()
      await expect(mainOf(page).getByRole('button', { name: 'Stop' })).toBeVisible()
      await expect(mainOf(leePage).getByRole('button', { name: 'Stop' })).toHaveCount(0)
      await release('answer')
      await expect(messageContaining(leePage, agentReplyText)).toHaveCount(1)

      await openChat(leePage, 'Welcome')
      await expect(sendButtonOf(leePage)).toBeDisabled()
      await expect(mainOf(leePage)).toContainText(readerNotice)
      await openMessageMenu(messageContaining(leePage, 'Thanks, glad to be here.'))
      await expect(leePage.getByRole('menuitem', { name: 'Start runtime from this message' })).toBeEnabled()
      await expect(leePage.getByRole('menuitem', { name: 'Edit' })).toBeDisabled()
      await expect(leePage.getByRole('menuitem', { name: 'Delete' })).toBeDisabled()
      await leePage.context().close()
    })
  })

  test.describe(() => {
    const repliesOf = (page: Page) => messageItemsOf(page).filter({ hasText: agentReplyText })

    const promptAndWait = async (page: Page, text: string, replies: number) => {
      await sendMessage(page, text)
      await expect(repliesOf(page)).toHaveCount(replies)
    }

    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

    test('As a prompter, I prompt on my own key, my session window is read-only and I get no Stop', {
      tag: ['@spec-28'],
    }, async ({ page, browser, workerStack, agentScript, release }) => {
      const chatId = await newRuntimeChat(page, 'Bob prompts')
      await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
      await promptAndWait(page, 'Alice starts', 1)
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await addLlmKey(bobPage, 'Fake')
      await openChat(bobPage, 'Bob prompts')
      await agentScript(chatId, { hold: 'answer' })
      await sendMessage(bobPage, 'Bob asks')
      await expect(workingIndicatorOf(bobPage)).toBeVisible()
      await expect(mainOf(page).getByRole('button', { name: 'Stop' })).toBeVisible()
      await expect(mainOf(bobPage).getByRole('button', { name: 'Stop' })).toHaveCount(0)
      await release('answer')
      await expect(repliesOf(bobPage)).toHaveCount(2)
      await expect
        .poll(async () =>
          (await workerStack.database.$client`select prompter_id from model_calls where chat_id = ${chatId}`).map(
            ({ prompter_id }) => prompter_id,
          ),
        )
        .toContain('member-bob')

      await expect(modeRadioOf(bobPage, 'Plan')).toBeDisabled()
      await openSession(bobPage)
      await expect(sessionOf(bobPage).getByLabel('Main model')).toHaveValue('fake/fake-medium')
      for (const label of ['Main model', 'Search all models', 'Effort', 'Subagents'])
        await expect(sessionOf(bobPage).getByLabel(label)).toBeDisabled()
      await expect(sessionOf(bobPage).getByRole('button', { name: 'Switch' })).toHaveCount(0)
      await bobPage.context().close()
    })
  })

  test.describe(() => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

    test('As a member who is not a participant, I read the public Welcome channel, and joining it makes me a Prompter who posts', {
      tag: ['@spec-28'],
    }, async ({ browser, workerStack }) => {
      const leePage = await openPageAs(browser, workerStack, 'member-lee')
      await sidebarOf(leePage)
        .getByRole('button', { name: /^Browse channels/ })
        .click()
      await leePage
        .getByRole('dialog', { name: 'Browse channels' })
        .getByRole('link', { name: /Welcome/ })
        .click()
      await tabOf(leePage, 'Members').click()
      await expect(messageContaining(leePage, 'Welcome to the team!')).toHaveCount(1)
      await expectMembers(leePage, [
        ['Alice', 'Owner'],
        ['Bob', 'Prompter'],
      ])
      await mainOf(leePage).getByRole('button', { name: 'Join channel' }).click()
      await sendMessage(leePage, 'Lee says hello')
      await expect(messageContaining(leePage, 'Lee says hello')).toHaveCount(1)
      await expectMembers(leePage, [
        ['Alice', 'Owner'],
        ['Lee', 'Prompter'],
        ['Bob', 'Prompter'],
      ])
      await leePage.context().close()
    })
  })

  test.describe(() => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

    test('As a chat owner, I am offered no custom role without Post in a public channel, and an Editor invites only with roles within his own permissions', {
      tag: ['@spec-47'],
    }, async ({ page, browser, workerStack }) => {
      await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
      await insertRole(workerStack, 'role-keeper', 'Keeper', ['chat.read', 'tools.manage'])
      await insertRole(workerStack, 'role-poster', 'Poster', ['chat.read', 'chat.post'])
      await openPanelTab(page, 'Welcome', 'Members')
      expect(await inviteRoleOptionsOf(page)).toEqual(['Editor', 'Prompter', 'Poster'])

      const chatId = await newRuntimeChat(page, 'Bob edits roles')
      await addParticipant(workerStack, chatId, 'member-bob', 'editor')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await openPanelTab(bobPage, 'Bob edits roles', 'Members')
      expect(await inviteRoleOptionsOf(bobPage)).toEqual(['Editor', 'Prompter', 'Poster', 'Reviewer', 'Reader'])
      await bobPage.context().close()
    })
  })
})
