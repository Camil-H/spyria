import { jobs } from '@hq/db/postgres'
import {
  agentReplyText,
  chatAction,
  chatLinkOf,
  chipOf,
  composerOf,
  draftIconOf,
  expect,
  type Locator,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  type Page,
  sendButtonOf,
  sendMessage,
  sidebarOf,
  test,
  workingIndicatorOf,
} from './fixtures'
import type { WorkerStack } from './stack'

const messagesOf = (page: Page) => page.getByRole('list', { name: 'Messages' })

const openMessageMenu = async (message: Locator) => {
  await message.hover()
  await message.getByRole('button', { name: 'Message actions' }).click()
}
const openMessageAction = async (page: Page, messageText: string, actionName: string) => {
  await openMessageMenu(messageContaining(page, messageText))
  await page.getByRole('menuitem', { name: actionName }).click()
}
const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete message' })
const agentPromptJobs = async (workerStack: WorkerStack) =>
  (await workerStack.database.select().from(jobs)).filter((job) => job.type === 'agent.prompt')

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:34:00Z'))
  await page.goto('/')
})

test('shows the Welcome channel, its composer, message menu and dialogs', async ({ page, workerStack }) => {
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

  await test.step('shows Send as an icon with a tooltip', async () => {
    await expect(sendButtonOf(page)).toHaveText('')
    await sendButtonOf(page).hover()
    await expect(page.getByRole('tooltip', { name: 'Send (⌘↵)' })).toBeVisible()
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

  await test.step('places the pencil at the right end of the row, before the menu button', async () => {
    await composerOf(page).fill('Draft')
    const chatNameBox = await chatLinkOf(page, 'Welcome').getByText('Welcome', { exact: true }).boundingBox()
    const pencilBox = await draftIconOf(page, 'Welcome').boundingBox()
    const menuButtonBox = await page.getByRole('button', { name: 'Chat actions for Welcome' }).boundingBox()
    expect(pencilBox!.x).toBeGreaterThan(chatNameBox!.x + chatNameBox!.width)
    expect(pencilBox!.x + pencilBox!.width).toBeLessThanOrEqual(menuButtonBox!.x)
  })

  await test.step('offers the three actions, with edit and delete enabled on own messages', async () => {
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await expect(page.getByRole('menuitem', { name: 'Start runtime from this message' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeEnabled()
    await page.keyboard.press('Escape')
  })

  await test.step('disables edit and delete on messages of other members', async () => {
    await openMessageMenu(messageContaining(page, 'Welcome to the team!'))
    await expect(page.getByRole('menuitem', { name: 'Start runtime from this message' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem')).toHaveCount(0)
  })

  await test.step('reveals the menu button on keyboard focus', async () => {
    const messageActionsButton = messageContaining(page, 'Thanks, glad to be here.').getByRole('button', {
      name: 'Message actions',
    })
    await messageActionsButton.focus()
    await expect(messageActionsButton).toBeVisible()
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

  await test.step('uses the text color of the app for the delete message dialog title in dark mode', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openMessageAction(page, 'Thanks, glad to be here.', 'Delete')
    const dialogTitleColor = await deleteDialogOf(page)
      .getByRole('heading', { name: 'Delete message' })
      .evaluate((element) => getComputedStyle(element).color)
    const pageTitleColor = await mainOf(page)
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).color)
    expect(dialogTitleColor).toBe(pageTitleColor)
    await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('a link in a message has a contrast of at least 4.5:1 against the message background in light mode', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    const chatId = page.url().split('/').at(-1) ?? ''
    await workerStack.database.$client`
      insert into messages (workspace_id, chat_id, id, seq, kind, body, created_at)
      select workspace_id, id, 'link-message', (select coalesce(max(seq), 0) + 1 from messages where chat_id = ${chatId}), 'agent',
        'See [the docs](https://example.com/docs) for more.', now()
      from chats where id = ${chatId}`
    const link = messageContaining(page, 'See the docs').getByRole('link', { name: 'the docs' })
    await expect(link).toBeVisible()
    const { foreground, background } = await link.evaluate((element) => {
      const channelsOf = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number)
      let node: Element | null = element
      let background = [255, 255, 255, 1]
      for (; node; node = node.parentElement) {
        const channels = channelsOf(getComputedStyle(node).backgroundColor)
        if ((channels[3] ?? 1) > 0) {
          background = channels
          break
        }
      }
      return { foreground: channelsOf(getComputedStyle(element).color), background }
    })
    const luminanceOf = ([red = 0, green = 0, blue = 0]: number[]) => {
      const [r = 0, g = 0, b = 0] = [red, green, blue].map((channel) => {
        const value = channel / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const [lighter = 0, darker = 0] = [luminanceOf(foreground), luminanceOf(background)].sort((x, y) => y - x)
    const ratio = (lighter + 0.05) / (darker + 0.05)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})

test('shows the runtime chats, their header and history', async ({ page }) => {
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
    await expect(chipOf(page, 'hq')).toHaveText('Sonnet 5.5 (high)')
    await expect(mainOf(page)).toContainText('fix/invoice-tax')
    await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toBeVisible()
    await expect(messageContaining(page, 'Why do invoices show the wrong total?')).toContainText('Alice')
    await expect(messageContaining(page, 'Checking the invoice calculation.')).toContainText('Agent')
    await expect(messageContaining(page, 'The tax is applied twice.')).toContainText('Agent')
  })

  await test.step('has no message menu in a runtime chat', async () => {
    await expect(page.getByRole('button', { name: 'Message actions' })).toHaveCount(0)
  })

  await test.step('puts the owner on the title row, aligned right, the git branch above the text box, aligned left, and the Runs on chip with the runtime status and the model chip in the bar under it, the status inside the Runs on chip', async () => {
    const titleBox = (await mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' }).boundingBox())!
    const ownerBox = (await mainOf(page).getByText('Agent acts as Alice').boundingBox())!
    const branchBox = (await mainOf(page).getByText('fix/invoice-tax').boundingBox())!
    const modelBox = (await chipOf(page, 'hq').boundingBox())!
    const runtimeBox = (await mainOf(page).getByRole('status', { name: 'Runtime' }).boundingBox())!
    const composerBox = (await composerOf(page).boundingBox())!
    expect(Math.abs(ownerBox.y + ownerBox.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThan(16)
    expect(ownerBox.x).toBeGreaterThan(titleBox.x + titleBox.width)
    const header = mainOf(page).locator('header')
    await expect(header).not.toContainText('fix/invoice-tax')
    await expect(header).not.toContainText('Sonnet 5.5 (high)')
    await expect(header.getByRole('status', { name: 'Runtime' })).toHaveCount(0)
    expect(branchBox.y + branchBox.height).toBeLessThanOrEqual(composerBox.y)
    expect(composerBox.y - (branchBox.y + branchBox.height)).toBeLessThan(48)
    expect(Math.abs(branchBox.x - composerBox.x)).toBeLessThan(48)
    for (const chipBox of [modelBox, runtimeBox]) {
      expect(chipBox.y).toBeGreaterThanOrEqual(composerBox.y + composerBox.height)
      expect(chipBox.y - (composerBox.y + composerBox.height)).toBeLessThan(48)
    }
    const runsOnRight = await mainOf(page)
      .getByRole('combobox', { name: 'Runs on' })
      .evaluate((select) => select.getBoundingClientRect().right)
    expect(runtimeBox.x).toBeGreaterThan(runsOnRight)
    expect(runtimeBox.x - runsOnRight).toBeLessThan(24)
    expect(runtimeBox.x + runtimeBox.width).toBeLessThan(modelBox.x)
    expect(Math.abs(runtimeBox.y + runtimeBox.height / 2 - (modelBox.y + modelBox.height / 2))).toBeLessThan(4)
  })

  await test.step('shows the name of the member the agent acts as in bold', async () => {
    const ownerNameWeight = await mainOf(page)
      .getByText('Alice', { exact: true })
      .first()
      .evaluate((element) => Number(getComputedStyle(element).fontWeight))
    expect(ownerNameWeight).toBeGreaterThanOrEqual(600)
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
    await expect(chipOf(page, 'hq')).toHaveText('GPT-5 (medium)')
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

test('sends in a channel, keeps chats and drafts apart and scrolls to the newest message', async ({
  page,
  workerStack,
}) => {
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
    await expect(draftIconOf(page, 'Standup')).toHaveCount(0)
    await openChat(page, 'Welcome')
    await expect(messageContaining(page, 'Sent from the keyboard')).toBeVisible()
    await expect(composerOf(page)).toHaveValue('Work in progress')
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
})

test('allows sending while the agent works and replies once per message in order', async ({ page }) => {
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

test('starts runtime chats from channel messages', async ({ page, workerStack }) => {
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
      .poll(() => workerStack.database.query.messages.findFirst({ where: { replyToId: 'message-welcome-2' } }))
      .toBeDefined()
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

test('edits then deletes an own message', async ({ page }) => {
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
