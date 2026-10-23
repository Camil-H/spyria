import { openPageAs, runtimeStateOf } from '../stack'
import {
  addParticipant,
  agentReplyText,
  composerOf,
  expect,
  forEachHarness,
  mainOf,
  messageContaining,
  messageItemsOf,
  newHarnessChat,
  newRuntimeChat,
  newSessionNotice,
  openChat,
  type Page,
  research,
  sendButtonOf,
  sendMessage,
  machineTest as test,
  turnEnded,
  unreadIconOf,
  workingIndicatorOf,
} from './fixtures'

const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const branchOf = (page: Page) => mainOf(page).getByRole('img', { name: 'Git branch' }).locator('xpath=..')

test.describe('Conversation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test.describe(() => {
    test.use({ warmRuntimes: false })

    test('As a prompter, my first prompt starts the agent, shown working until its reply arrives', {
      tag: ['@spec-09'],
    }, async ({ page, workerStack }) => {
      expect(await runtimeStateOf(workerStack, research)).toBeUndefined()
      await openChat(page, 'Research')
      await sendMessage(page, 'Find the latest pricing')

      await expect(workingIndicatorOf(page)).toBeVisible()
      await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(messageItemsOf(page).nth(0)).toContainText('Find the latest pricing')
      await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
      expect(await runtimeStateOf(workerStack, research)).toBe('running')
    })
  })

  test('As a prompter, my prompt and its reply stay after a reload, and the chat is not unread for me', {
    tag: ['@spec-09'],
  }, async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Remember this')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    await page.reload()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
    await expect(messageItemsOf(page)).toHaveCount(2)
    await expect(messageItemsOf(page).nth(0)).toContainText('Remember this')
    await expect(messageItemsOf(page).nth(1)).toContainText(agentReplyText)
    await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
  })

  test('As a prompter, I reload during a turn and see my prompt, then the reply once it completes, without a duplicate', {
    tag: ['@spec-09'],
  }, async ({ page, agentScript, release }) => {
    await agentScript(research, { hold: 'answer' })
    await openChat(page, 'Research')
    await sendMessage(page, 'Stream through a reload')
    await expect(messageContaining(page, 'Understood,')).toHaveCount(1)

    await page.reload()
    await expect(messageContaining(page, 'Stream through a reload')).toHaveCount(1)
    await release('answer')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(2)
  })

  test('As a prompter, I send while the agent works and get one reply per message, in order', async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'First question')
    await expect(workingIndicatorOf(page)).toBeVisible()

    await composerOf(page).fill('Second question')
    await expect(sendButtonOf(page)).toBeEnabled()
    await composerOf(page).press('ControlOrMeta+Enter')

    await expect(messageContaining(page, 'Second question')).toBeVisible()
    await expect(workingIndicatorOf(page)).toBeVisible()
    await expect(messageContaining(page, agentReplyText)).toHaveCount(2)
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    await expect(messageItemsOf(page)).toHaveCount(4)
    await expect(messageItemsOf(page).nth(0)).toContainText('First question')
    await expect(messageItemsOf(page).nth(1)).toContainText(agentReplyText)
    await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
    await expect(messageItemsOf(page).nth(2)).toContainText('Second question')
    await expect(messageItemsOf(page).nth(3)).toContainText(agentReplyText)
  })

  test('As a prompter, I see the working directory, then the branch once the agent switches to one, also after a reload', {
    tag: ['@spec-25', '@stage-e'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Branch chip')
    await sendMessage(page, 'stub:hello')
    await turnEnded(page, 1)
    await expect(workingDirectoryOf(page)).toBeVisible()
    await expect(branchOf(page)).toHaveCount(0)

    await sendMessage(page, 'stub:branch feature/composer')
    await turnEnded(page, 2)
    await expect(branchOf(page)).toHaveText('feature/composer')

    await page.reload()
    await expect(branchOf(page)).toHaveText('feature/composer')
    await expect(workingDirectoryOf(page)).toHaveText(/^workspace-\d+$/)
  })

  forEachHarness((harness) => {
    test(`As a member watching, I see the reply stream in, then the stored reply once, with no unread icon [${harness.name}]`, {
      tag: ['@spec-09'],
    }, async ({ page, browser, workerStack, agentScript, release, machine }) => {
      if (harness.name === 'Pi') {
        await agentScript(research, { hold: 'answer' })
        await addParticipant(workerStack, research, 'member-bob', 'reader')
        const bobPage = await openPageAs(browser, workerStack, 'member-bob')
        await openChat(bobPage, 'Research')
        await openChat(page, 'Research')
        await sendMessage(page, 'Watch this')

        await expect(messageContaining(bobPage, 'Watch this')).toHaveCount(1)
        const bobReply = messageItemsOf(bobPage).nth(1)
        await expect(bobReply).toContainText('Understood,')
        expect(await bobReply.textContent()).not.toContain(agentReplyText)
        await release('answer')
        await expect(bobReply).toContainText(agentReplyText)
        await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
        await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
        await expect(unreadIconOf(bobPage, 'Research')).toHaveCount(0)
        await bobPage.context().close()
        return
      }
      const chatName = `${harness.name} watched`
      const chatId = await newHarnessChat(page, harness, chatName, { machine, workerStack })
      await addParticipant(workerStack, chatId, 'member-bob', 'reader')
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      await openChat(bobPage, chatName)
      await sendMessage(page, 'stub:linger Watch this')

      await expect(messageContaining(bobPage, 'Watch this')).toHaveCount(1)
      const bobReply = messageItemsOf(bobPage).nth(1)
      await expect(bobReply).toContainText('[t1]')
      expect(await bobReply.textContent()).not.toContain('Hello from the stub')
      await release('linger')
      await expect(bobReply).toContainText('Hello from the stub')
      await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
      await expect(messageContaining(bobPage, 'Hello from the stub')).toHaveCount(1)
      await expect(unreadIconOf(bobPage, chatName)).toHaveCount(0)
      await bobPage.context().close()
    })

    test(`As a prompter, after leaving and reopening the chat, I see a turn stream each word once and the stored answer match it [${harness.name}]`, {
      tag: ['@spec-25', '@stage-f'],
    }, async ({ page, agentScript, reached, release, machine, workerStack }) => {
      if (harness.name === 'Pi') {
        await openChat(page, 'Research')
        for (const _ of [1, 2]) {
          await openChat(page, 'Welcome')
          await openChat(page, 'Research')
        }
        await agentScript(research, { text: 'Alpha beta gamma delta.', hold: 'stream' })
        await sendMessage(page, 'Stream it')
        await reached('stream')
        const answer = messageContaining(page, 'Alpha')
        await expect(answer).toBeVisible()
        await expect(answer).not.toContainText(/Alpha\s*Alpha/)
        await release('stream')
        await expect(workingIndicatorOf(page)).toHaveCount(0)
        await expect(answer).toHaveCount(1)
        await expect(answer).toContainText('Alpha beta gamma delta.')
        return
      }
      const chatName = `${harness.name} reopened`
      await newHarnessChat(page, harness, chatName, { machine, workerStack })
      for (const _ of [1, 2]) {
        await openChat(page, 'Welcome')
        await openChat(page, chatName)
      }
      await sendMessage(page, 'stub:linger Stream it')
      const answer = messageContaining(page, '[t1]')
      await expect(answer).toBeVisible()
      await expect(answer).not.toContainText(/\[t1\]\s*\[t1\]/)
      await release('linger')
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(answer).toHaveCount(1)
      await expect(answer).toContainText('Hello from the stub')
    })

    test(`As a prompter, I stop a turn during a command and the prompt I queued behind it is answered next in the same session [${harness.name}]`, {
      tag: ['@spec-25'],
    }, async ({ page, agentScript, machine, workerStack }) => {
      if (harness.name === 'Pi') {
        await openChat(page, 'Research')
        await agentScript(research, { steps: [{ command: 'sleep 30' }], text: 'Never shown.' })
        await sendMessage(page, 'Sleep for a while')
        await expect(messageContaining(page, 'sleep 30').getByRole('img', { name: 'Running' })).toBeVisible()
        await sendMessage(page, 'Carry on')
        await expect(messageContaining(page, 'Carry on')).toHaveCount(1)
        await agentScript(research, { text: 'Carried on.' })
        await mainOf(page).getByRole('button', { name: 'Stop' }).click()
        await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)

        await expect(messageContaining(page, 'Carried on.')).toHaveCount(1)
        await expect(workingIndicatorOf(page)).toHaveCount(0)
        await expect(messageItemsOf(page).nth(0)).toContainText('Sleep for a while')
        await expect(messageItemsOf(page).nth(-3)).toContainText('Stopped by Alice')
        await expect(messageItemsOf(page).nth(-2)).toContainText('Carry on')
        await expect(messageItemsOf(page).nth(-1)).toContainText('Carried on.')
        await expect(mainOf(page)).not.toContainText('Never shown.')
        await expect(mainOf(page)).not.toContainText(newSessionNotice)
        return
      }
      await newHarnessChat(page, harness, `${harness.name} stopped`, { machine, workerStack })
      await sendMessage(page, 'stub:long Sleep for a while')
      await expect(messageContaining(page, 'sleep 600').getByRole('img', { name: 'Running' })).toBeVisible()
      await sendMessage(page, 'Carry on')
      await expect(messageContaining(page, 'Carry on')).toHaveCount(1)
      await mainOf(page).getByRole('button', { name: 'Stop' }).click()
      await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)

      await expect(messageContaining(page, '[t2] Hello from the stub')).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(messageItemsOf(page).nth(0)).toContainText('Sleep for a while')
      await expect(messageItemsOf(page).nth(-3)).toContainText('Stopped by Alice')
      await expect(messageItemsOf(page).nth(-2)).toContainText('Carry on')
      await expect(messageItemsOf(page).nth(-1)).toContainText('[t2] Hello from the stub')
      await expect(mainOf(page)).not.toContainText(newSessionNotice)
    })
  })
})
