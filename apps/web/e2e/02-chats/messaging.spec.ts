import { jobs } from '@spyria/db/postgres'
import type { WorkerStack } from '../stack'
import {
  agentReplyText,
  chatLinkOf,
  chipOf,
  composerOf,
  draftIconOf,
  expect,
  mainOf,
  messageActionOf,
  messageActionsOf,
  messageContaining,
  messageItemsOf,
  openChat,
  type Page,
  sendButtonOf,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'

const messagesOf = (page: Page) => page.getByRole('list', { name: 'Messages' })

const openMessageAction = async (page: Page, messageText: string, actionName: string) =>
  (await messageActionOf(messageContaining(page, messageText), actionName)).click()
const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete message' })
const agentPromptJobs = async (workerStack: WorkerStack) =>
  (await workerStack.database.select().from(jobs)).filter((job) => job.type === 'agent.prompt')

test.describe('Messaging', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-01T12:34:00Z'))
    await page.goto('/')
  })

  test('As a member, I send in a channel, keep a draft per chat and see the newest message scrolled into view', {
    tag: ['@smoke'],
  }, async ({ page, workerStack }) => {
    await openChat(page, 'Welcome')

    await test.step('sends with the Send button, clears the textbox and keeps focus in it', async () => {
      await composerOf(page).fill('Hello team')
      await sendButtonOf(page).click()
      await expect(messageItemsOf(page)).toHaveCount(3)
      await expect(messageItemsOf(page).nth(2)).toContainText('Alice')
      await expect(messageItemsOf(page).nth(2)).toContainText(/\d{2}:\d{2}/)
      await expect(messageItemsOf(page).nth(2)).toContainText('Hello team')
      await expect(composerOf(page)).toHaveValue('')
      await expect(composerOf(page)).toBeFocused()
    })

    await test.step('appends only the member message', async () => {
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect
        .poll(() => workerStack.database.query.messages.findFirst({ where: { body: 'Hello team' } }))
        .toBeDefined()
      expect(await agentPromptJobs(workerStack)).toEqual([])
      await expect(messageContaining(page, agentReplyText)).toHaveCount(0)
      await expect(messageItemsOf(page)).toHaveCount(3)
    })

    await test.step('sends with Cmd+Enter', async () => {
      await sendMessage(page, 'Sent from the keyboard')
      await expect(messageContaining(page, 'Sent from the keyboard')).toBeVisible()
      await expect(composerOf(page)).toHaveValue('')
    })

    await test.step('keeps each chat messages separate and persistent while switching, with a draft per chat', async () => {
      await composerOf(page).fill('Work in progress')
      await expect(draftIconOf(page, 'Welcome')).toBeVisible()
      await openChat(page, 'Standup')
      await expect(messageContaining(page, 'Sent from the keyboard')).toHaveCount(0)
      await expect(messageContaining(page, 'Standup at 10.')).toBeVisible()
      await expect(composerOf(page)).toHaveValue('')
      await expect(draftIconOf(page, 'Welcome')).toBeVisible()
      await expect(chatLinkOf(page, 'Welcome')).toHaveAccessibleName('Welcome')
      await expect(chatLinkOf(page, 'Welcome')).toHaveAccessibleDescription('Channel Has unsent draft')
      await expect(draftIconOf(page, 'Standup')).toHaveCount(0)
      await openChat(page, 'Welcome')
      await expect(messageContaining(page, 'Sent from the keyboard')).toBeVisible()
      await expect(composerOf(page)).toHaveValue('Work in progress')
    })

    await test.step('keeps the draft typed just before a reload', async () => {
      await composerOf(page).fill('Work in progress, typed just before a reload')
      await page.reload()
      await expect(composerOf(page)).toHaveValue('Work in progress, typed just before a reload')
    })

    await test.step('clears the draft and the pencil when the message is sent', async () => {
      await composerOf(page).press('ControlOrMeta+Enter')
      await expect(draftIconOf(page, 'Welcome')).toHaveCount(0)
    })

    await test.step('scrolls the newest message into view when opening a chat and after sending', async () => {
      await workerStack.database.$client.begin(async (sql) => {
        await sql`select 1 from chats where id = 'chat-welcome' for update`
        await sql`
        with fillers as (
          select 'filler-' || number as id, 'Filler ' || number as body,
            (select max(seq) from events where chat_id = 'chat-welcome') + number as seq
          from generate_series(1, 29) as number
        ), posted as (
          insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
          select 'workspace-acme', 'chat-welcome', id, seq, 'message.posted', 'member-alice',
            jsonb_build_object('kind', 'member', 'body', body, 'detail', null, 'replyToId', null), now()
          from fillers
        )
        insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
        select 'workspace-acme', 'chat-welcome', id, seq, 'member', 'member-alice', body, now() from fillers`
      })
      await expect(messageContaining(page, 'Filler 29')).toHaveCount(1)
      await sendMessage(page, 'Filler 30')
      await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
      await expect(messageContaining(page, 'Welcome to the team!')).not.toBeInViewport()
      await openChat(page, 'Standup')
      await openChat(page, 'Welcome')
      await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
    })

    await test.step('shows the messages of a chat all at once when opening it, not the newest first', async () => {
      await openChat(page, 'Standup')
      await page.evaluate(() => {
        const welcomeCounts = new Set<number>()
        Object.assign(window, { welcomeCounts })
        new MutationObserver(() => {
          if (document.querySelector('main h1')?.textContent !== 'Welcome') return
          const count = document.querySelectorAll('ol[aria-label="Messages"] > li').length
          if (count > 0) welcomeCounts.add(count)
        }).observe(document.body, { childList: true, subtree: true, characterData: true })
      })
      await openChat(page, 'Welcome')
      await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
      const welcomeCounts = await page.evaluate(() => [
        ...(window as unknown as { welcomeCounts: Set<number> }).welcomeCounts,
      ])
      expect(welcomeCounts).toHaveLength(1)
    })

    await test.step('offers Go to last message while reading earlier messages, and goes back to the newest', async () => {
      const goToLastMessage = mainOf(page).getByRole('button', { name: 'Go to last message' })
      await expect(goToLastMessage).toHaveCount(0)
      await messageContaining(page, 'Welcome to the team!').scrollIntoViewIfNeeded()
      await expect(goToLastMessage).toBeVisible()
      await expect(messageContaining(page, 'Filler 30')).not.toBeInViewport()
      await goToLastMessage.click()
      await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
      await expect(goToLastMessage).toHaveCount(0)
    })

    await test.step('opens on the newest 50 messages and loads the earlier ones when scrolling up', async () => {
      await workerStack.database.$client.begin(async (sql) => {
        await sql`select 1 from chats where id = 'chat-welcome' for update`
        await sql`
        with fillers as (
          select 'later-' || number as id, 'Later ' || number as body,
            (select max(seq) from events where chat_id = 'chat-welcome') + number as seq
          from generate_series(1, 20) as number
        ), posted as (
          insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
          select 'workspace-acme', 'chat-welcome', id, seq, 'message.posted', 'member-alice',
            jsonb_build_object('kind', 'member', 'body', body, 'detail', null, 'replyToId', null), now()
          from fillers
        )
        insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
        select 'workspace-acme', 'chat-welcome', id, seq, 'member', 'member-alice', body, now() from fillers`
      })
      await expect(messageContaining(page, 'Later 20')).toHaveCount(1)
      await openChat(page, 'Standup')
      await openChat(page, 'Welcome')
      await expect(messageContaining(page, 'Later 20')).toBeInViewport()
      await expect(messageItemsOf(page)).toHaveCount(50)
      await expect(messageContaining(page, 'Welcome to the team!')).toHaveCount(0)
      await expect(mainOf(page).getByRole('button', { name: 'Show earlier messages' })).toBeVisible()
      await messagesOf(page).evaluate((list) => list.parentElement?.scrollTo({ top: 0 }))
      await expect(messageContaining(page, 'Welcome to the team!')).toHaveCount(1)
      await expect(mainOf(page).getByRole('button', { name: 'Show earlier messages' })).toHaveCount(0)
    })
  })

  test('As a member, a message refused for sending too fast shows why and I resend it', {
    tag: ['@spec-51'],
  }, async ({ page, workerStack, refuseNextMessage }) => {
    await openChat(page, 'Welcome')
    const notSent = mainOf(page).getByRole('alert')

    await test.step('gets the text back in the composer with the reason, and no message is posted', async () => {
      await refuseNextMessage()
      await sendMessage(page, 'Sent too fast')
      await expect(notSent).toHaveText('Not sent: Too many requests: try again in 12 seconds.')
      await expect(composerOf(page)).toHaveValue('Sent too fast')
      await expect(messageContaining(page, 'Sent too fast')).toHaveCount(0)
      expect(await workerStack.database.query.messages.findFirst({ where: { body: 'Sent too fast' } })).toBeUndefined()
    })

    await test.step('resends it with Send: the message is posted once and the reason goes away', async () => {
      await sendButtonOf(page).click()
      await expect(messageContaining(page, 'Sent too fast')).toHaveCount(1)
      await expect(composerOf(page)).toHaveValue('')
      await expect(notSent).toHaveCount(0)
      await expect
        .poll(
          async () => (await workerStack.database.query.messages.findMany({ where: { body: 'Sent too fast' } })).length,
        )
        .toBe(1)
    })
  })

  test('As a member, I mention a workspace member with @ and the mention shows in bold', async ({ page }) => {
    await openChat(page, 'Welcome')
    const mentionListOf = () => page.getByRole('listbox', { name: 'Members to mention' })

    await test.step('lists the workspace members after @, narrowed by what I type', async () => {
      await composerOf(page).pressSequentially('Thanks @')
      await expect(mentionListOf().getByRole('option')).toHaveText(['Alice', 'Bob', 'Lee'])
      await composerOf(page).pressSequentially('b')
      await expect(mentionListOf().getByRole('option')).toHaveText(['Bob'])
      await expect(mentionListOf().getByRole('option', { name: 'Bob' })).toHaveAttribute('aria-selected', 'true')
    })

    await test.step('inserts the chosen name with Enter, without sending', async () => {
      await composerOf(page).press('Enter')
      await expect(composerOf(page)).toHaveValue('Thanks @Bob ')
      await expect(mentionListOf()).toHaveCount(0)
      await expect(messageItemsOf(page)).toHaveCount(2)
    })

    await test.step('closes the list with Escape and picks with a click', async () => {
      await composerOf(page).pressSequentially('and @')
      await expect(mentionListOf()).toBeVisible()
      await composerOf(page).press('Escape')
      await expect(mentionListOf()).toHaveCount(0)
      await composerOf(page).pressSequentially(' @l')
      await mentionListOf().getByRole('option', { name: 'Lee' }).click()
      await expect(composerOf(page)).toHaveValue('Thanks @Bob and @ @Lee ')
      await expect(composerOf(page)).toBeFocused()
    })

    await test.step('shows the mentions of members in bold in the sent message', async () => {
      await composerOf(page).fill('Thanks @Bob and @Lee, not @Zoe or bob@example.com')
      await sendButtonOf(page).click()
      const sent = messageContaining(page, 'Thanks')
      await expect(sent.locator('strong')).toHaveText(['@Bob', '@Lee'])
    })
  })

  test('As a member, I edit then delete my own message', async ({ page }) => {
    await openChat(page, 'Welcome')

    await test.step('prefills the text and saves the edit with an edited marker', async () => {
      await openMessageAction(page, 'Thanks, glad to be here.', 'Edit')
      const editBox = page.getByRole('textbox', { name: 'Edit message' })
      await expect(editBox).toHaveValue('Thanks, glad to be here.')
      await editBox.fill('Thanks, happy to be here.')
      await page.getByRole('button', { name: 'Save' }).click()
      const editedMessage = messageContaining(page, 'Thanks, happy to be here.')
      await expect(editedMessage).toContainText('(edited)')
      await expect(editedMessage).toContainText('Alice')
      await expect(editedMessage).toContainText('09:02')
      await expect(messageContaining(page, 'glad to be here')).toHaveCount(0)
    })

    await test.step('replaces the message with a tombstone after confirmation', async () => {
      await openMessageAction(page, 'Thanks, happy to be here.', 'Delete')
      await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
      await expect(messageContaining(page, 'This message was deleted')).toBeVisible()
      await expect(messageContaining(page, 'Thanks, happy to be here.')).toHaveCount(0)
      await expect(messageItemsOf(page)).toHaveCount(2)
    })
  })
  test('As a member, I read a channel with its authors and times, and its composer and message menu allow only what I may do', async ({
    page,
  }) => {
    await openChat(page, 'Welcome')

    await test.step('shows the channel header and its messages with author, time and body', async () => {
      await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Channel view')
      await expect(mainOf(page)).not.toContainText('Agent acts as')
      await expect(mainOf(page)).not.toContainText('GPT-5')
      await expect(mainOf(page)).not.toContainText('Claude Sonnet 5.5')
      await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toHaveCount(0)
      await expect(messageItemsOf(page)).toHaveCount(2)
      await expect(messageItemsOf(page).nth(0)).toContainText('Bob')
      await expect(messageItemsOf(page).nth(0)).toContainText('09:00')
      await expect(messageItemsOf(page).nth(0)).toContainText('Welcome to the team!')
      await expect(messageItemsOf(page).nth(1)).toContainText('Alice')
      await expect(messageItemsOf(page).nth(1)).toContainText('09:02')
      await expect(messageItemsOf(page).nth(1)).toContainText('Thanks, glad to be here.')
    })

    await test.step('disables Send while the text is blank or whitespace', async () => {
      await expect(sendButtonOf(page)).toBeDisabled()
      await composerOf(page).fill('   ')
      await expect(sendButtonOf(page)).toBeDisabled()
      await composerOf(page).fill('Hello')
      await expect(sendButtonOf(page)).toBeEnabled()
    })

    await test.step('inserts a new line on Enter and Shift+Enter without sending', async () => {
      await composerOf(page).fill('first')
      await composerOf(page).press('Enter')
      await composerOf(page).pressSequentially('second')
      await composerOf(page).press('Shift+Enter')
      await composerOf(page).pressSequentially('third')
      await expect(composerOf(page)).toHaveValue('first\nsecond\nthird')
      await expect(messageItemsOf(page)).toHaveCount(2)
    })

    await test.step('shows no pencil for a whitespace-only draft', async () => {
      await composerOf(page).fill('   ')
      await expect(draftIconOf(page, 'Welcome')).toHaveCount(0)
    })

    await test.step('offers the actions side by side, with edit and delete on own messages', async () => {
      const ownMessage = messageContaining(page, 'Thanks, glad to be here.')
      await expect(await messageActionOf(ownMessage, 'Start runtime from this message')).toBeEnabled()
      await expect(await messageActionOf(ownMessage, /^Copy (message|thread) as context$/)).toBeEnabled()
      await expect(await messageActionOf(ownMessage, 'Edit')).toBeEnabled()
      await expect(await messageActionOf(ownMessage, 'Delete')).toBeEnabled()
    })

    await test.step('leaves edit and delete out on messages of other members', async () => {
      const othersMessage = messageContaining(page, 'Welcome to the team!')
      await expect(await messageActionOf(othersMessage, 'Start runtime from this message')).toBeEnabled()
      await expect(await messageActionOf(othersMessage, 'Edit')).toHaveCount(0)
      await expect(await messageActionOf(othersMessage, 'Delete')).toHaveCount(0)
    })

    await test.step('keeps the original text on cancel', async () => {
      await openMessageAction(page, 'Thanks, glad to be here.', 'Edit')
      await page.getByRole('textbox', { name: 'Edit message' }).fill('Something else')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(messageContaining(page, 'Thanks, glad to be here.')).not.toContainText('(edited)')
      await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    })

    await test.step('cannot save a blank text', async () => {
      await openMessageAction(page, 'Thanks, glad to be here.', 'Edit')
      await page.getByRole('textbox', { name: 'Edit message' }).fill('   ')
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    })

    await test.step('keeps the message when the deletion is cancelled', async () => {
      await openMessageAction(page, 'Thanks, glad to be here.', 'Delete')
      await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
      await expect(deleteDialogOf(page)).toHaveCount(0)
      await expect(messageContaining(page, 'Thanks, glad to be here.')).toBeVisible()
    })
  })

  test('As a member, I read a runtime chat’s history with its owner, model, branch and tool calls, and an empty chat invites the first prompt', async ({
    page,
  }) => {
    await test.step('moves focus to the composer when a chat is opened from the sidebar', async () => {
      await chatLinkOf(page, 'Welcome').click()
      await expect(composerOf(page)).toBeFocused()
      await chatLinkOf(page, 'Invoice bug').click()
      await expect(composerOf(page)).toBeFocused()
    })

    await test.step('shows member and agent messages and the runtime header', async () => {
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' })).toBeVisible()
      await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Runtime view')
      await expect(mainOf(page)).toContainText('Agent acts as Alice')
      await expect(chipOf(page, 'spyria')).toHaveText('Sonnet 5.5 (high)')
      await expect(mainOf(page)).toContainText('fix/invoice-tax')
      await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toBeVisible()
      await expect(messageContaining(page, 'Why do invoices show the wrong total?')).toContainText('Alice')
      await expect(messageContaining(page, 'Checking the invoice calculation.')).toContainText('Agent')
      await expect(messageContaining(page, 'The tax is applied twice.')).toContainText('Agent')
    })

    await test.step('offers only Copy link to message in a runtime chat’s message menu', async () => {
      const actions = messageActionsOf(messageContaining(page, 'Why do invoices show the wrong total?')).getByRole(
        'button',
      )
      await expect(actions).toHaveCount(1)
      await expect(actions).toHaveAccessibleName('Copy link to message')
    })

    await test.step('collapses and expands a tool call', async () => {
      const toolCallToggle = messagesOf(page).getByRole('button', { name: 'Read: billing/invoice.ts' })
      await expect(toolCallToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(messagesOf(page).getByText('export const total = ...')).toBeHidden()
      await toolCallToggle.click()
      await expect(toolCallToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(messagesOf(page).getByText('export const total = ...')).toBeVisible()
      await toolCallToggle.click()
      await expect(messagesOf(page).getByText('export const total = ...')).toBeHidden()
    })

    await test.step('shows the owner and the model of another runtime chat', async () => {
      await openChat(page, 'Setup helper')
      await expect(mainOf(page)).toContainText('Agent acts as Bob')
      await expect(chipOf(page, 'spyria')).toHaveText('GPT-5 (medium)')
      await expect(mainOf(page)).toContainText('main')
      await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toBeVisible()
      await expect(messageContaining(page, 'Dependencies installed.')).toContainText('Agent')
    })

    await test.step('shows an empty state, no git branch without a repository and keeps the composer available', async () => {
      await openChat(page, 'Research')
      await expect(mainOf(page)).toContainText('Model chosen at first prompt')
      await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toHaveCount(0)
      await expect(mainOf(page)).toContainText('No messages yet')
      await expect(messageItemsOf(page)).toHaveCount(0)
      await expect(composerOf(page)).toBeVisible()
    })
  })
})
