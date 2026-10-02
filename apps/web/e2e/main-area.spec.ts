import { expect, type Locator, type Page, test } from '@playwright/test'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const mainOf = (page: Page) => page.getByRole('main')
const messagesOf = (page: Page) => page.getByRole('list', { name: 'Messages' })
const messageItemsOf = (page: Page) => messagesOf(page).getByRole('listitem')
const messageContaining = (page: Page, text: string) => messageItemsOf(page).filter({ hasText: text })
const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const sendButtonOf = (page: Page) => page.getByRole('button', { name: 'Send' })
const workingIndicatorOf = (page: Page) => page.getByRole('status', { name: 'Agent is working' })
const sidebarChatLink = (page: Page, chatName: string) => sidebarOf(page).getByRole('link', { name: chatName })
const agentReplyText = 'Understood, working on it.'

const openChat = async (page: Page, chatName: string) => {
  await sidebarChatLink(page, chatName).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

const sendMessage = async (page: Page, text: string) => {
  await composerOf(page).fill(text)
  await composerOf(page).press('ControlOrMeta+Enter')
}

const openMessageMenu = async (message: Locator) => {
  await message.hover()
  await message.getByRole('button', { name: 'Message actions' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-01T12:34:00Z'))
  await page.goto('/')
})

test.describe('1. channel history', () => {
  test('shows the channel header and its messages with author, time and body', async ({ page }) => {
    await openChat(page, 'Welcome')
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
})

test.describe('2. runtime history', () => {
  test('shows member and agent messages and the runtime header', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Runtime view')
    await expect(mainOf(page)).toContainText('Agent acts as Alice')
    await expect(mainOf(page)).toContainText('Claude Sonnet 5.5 · High')
    await expect(mainOf(page)).toContainText('fix/invoice-tax')
    await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toBeVisible()

    await expect(messageContaining(page, 'Why do invoices show the wrong total?')).toContainText('Alice')
    await expect(messageContaining(page, 'Checking the invoice calculation.')).toContainText('Agent')
    await expect(messageContaining(page, 'The tax is applied twice.')).toContainText('Agent')
  })

  test('collapses and expands a tool call', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const toolCallToggle = messagesOf(page).getByRole('button', { name: 'Read: billing/invoice.ts' })
    await expect(toolCallToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(messagesOf(page).getByText('export const total = ...')).toBeHidden()

    await toolCallToggle.click()
    await expect(toolCallToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(messagesOf(page).getByText('export const total = ...')).toBeVisible()

    await toolCallToggle.click()
    await expect(messagesOf(page).getByText('export const total = ...')).toBeHidden()
  })

  test('shows the owner and the model of another runtime chat', async ({ page }) => {
    await openChat(page, 'Setup helper')
    await expect(mainOf(page)).toContainText('Agent acts as Bob')
    await expect(mainOf(page)).toContainText('GPT-5 · Medium')
    await expect(mainOf(page)).toContainText('main')
    await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toBeVisible()
    await expect(messageContaining(page, 'Dependencies installed.')).toContainText('Agent')
  })
})

test.describe('2b. runtime header row', () => {
  test('puts the owner, the model with its reasoning effort and the git branch on the title row, aligned right', async ({
    page,
  }) => {
    await openChat(page, 'Invoice bug')
    const titleBox = await mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' }).boundingBox()
    const ownerBox = await mainOf(page).getByText('Agent acts as Alice').boundingBox()
    const modelBox = await mainOf(page).getByText('Claude Sonnet 5.5 · High').boundingBox()
    const branchBox = await mainOf(page).getByText('fix/invoice-tax').boundingBox()

    for (const itemBox of [ownerBox, modelBox, branchBox]) {
      expect(Math.abs(itemBox!.y + itemBox!.height / 2 - (titleBox!.y + titleBox!.height / 2))).toBeLessThan(16)
    }
    const composerBox = await composerOf(page).boundingBox()
    expect(composerBox!.x + composerBox!.width - (branchBox!.x + branchBox!.width)).toBeLessThan(96)
    expect(ownerBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width)
    expect(modelBox!.x).toBeGreaterThan(ownerBox!.x + ownerBox!.width)
    expect(branchBox!.x).toBeGreaterThan(modelBox!.x + modelBox!.width)
  })

  test('shows the name of the member the agent acts as in bold', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    const ownerNameWeight = await mainOf(page)
      .getByText('Alice', { exact: true })
      .first()
      .evaluate((element) => Number(getComputedStyle(element).fontWeight))
    expect(ownerNameWeight).toBeGreaterThanOrEqual(600)
  })

  test('shows no git branch for a runtime chat without a repository', async ({ page }) => {
    await openChat(page, 'Research')
    await expect(mainOf(page)).toContainText('Claude Sonnet 5.5 · Medium')
    await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toHaveCount(0)
  })
})

test.describe('3. empty chat', () => {
  test('shows an empty state and keeps the composer available', async ({ page }) => {
    await openChat(page, 'Research')
    await expect(mainOf(page)).toContainText('No messages yet')
    await expect(messageItemsOf(page)).toHaveCount(0)
    await expect(composerOf(page)).toBeVisible()
  })
})

test.describe('4. composer', () => {
  test('disables Send while the text is blank or whitespace', async ({ page }) => {
    await openChat(page, 'Welcome')
    await expect(sendButtonOf(page)).toBeDisabled()
    await composerOf(page).fill('   ')
    await expect(sendButtonOf(page)).toBeDisabled()
    await composerOf(page).fill('Hello')
    await expect(sendButtonOf(page)).toBeEnabled()
  })

  test('shows Send as an icon with a tooltip', async ({ page }) => {
    await openChat(page, 'Welcome')
    await expect(sendButtonOf(page)).toHaveText('')
    await composerOf(page).fill('Hello')
    await sendButtonOf(page).hover()
    await expect(page.getByRole('tooltip', { name: 'Send (⌘↵)' })).toBeVisible()
  })

  test('sends with the Send button, clears the textbox and keeps focus in it', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('Hello team')
    await sendButtonOf(page).click()

    await expect(messageItemsOf(page)).toHaveCount(3)
    await expect(messageItemsOf(page).nth(2)).toContainText('Alice')
    await expect(messageItemsOf(page).nth(2)).toContainText('12:34')
    await expect(messageItemsOf(page).nth(2)).toContainText('Hello team')
    await expect(composerOf(page)).toHaveValue('')
    await expect(composerOf(page)).toBeFocused()
  })

  test('sends with Cmd+Enter', async ({ page }) => {
    await openChat(page, 'Welcome')
    await sendMessage(page, 'Sent from the keyboard')
    await expect(messageContaining(page, 'Sent from the keyboard')).toBeVisible()
    await expect(composerOf(page)).toHaveValue('')
  })

  test('inserts a new line on Enter and Shift+Enter without sending', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('first')
    await composerOf(page).press('Enter')
    await composerOf(page).pressSequentially('second')
    await composerOf(page).press('Shift+Enter')
    await composerOf(page).pressSequentially('third')

    await expect(composerOf(page)).toHaveValue('first\nsecond\nthird')
    await expect(messageItemsOf(page)).toHaveCount(2)
  })

  test('scrolls the newest message into view when opening a chat and after sending', async ({ page }) => {
    await openChat(page, 'Welcome')
    for (let messageNumber = 1; messageNumber <= 30; messageNumber++) await sendMessage(page, `Filler ${messageNumber}`)
    await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
    await expect(messageContaining(page, 'Welcome to the team!')).not.toBeInViewport()

    await openChat(page, 'Standup')
    await openChat(page, 'Welcome')
    await expect(messageContaining(page, 'Filler 30')).toBeInViewport()
  })
})

test.describe('5. send in a channel', () => {
  test('appends only the member message', async ({ page }) => {
    await openChat(page, 'Welcome')
    await sendMessage(page, 'Anyone around?')

    await expect(messageContaining(page, 'Anyone around?')).toBeVisible()
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await page.waitForTimeout(1500)
    await expect(messageContaining(page, agentReplyText)).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(3)
  })
})

test.describe('6. send in a runtime chat', () => {
  test('shows the working indicator, then the scripted agent reply', async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Find the latest pricing')

    await expect(workingIndicatorOf(page)).toBeVisible()
    await expect(messageContaining(page, agentReplyText)).toBeVisible()
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page).nth(0)).toContainText('Find the latest pricing')
    await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
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
    await expect(messageItemsOf(page).nth(2)).toContainText('Second question')
    await expect(messageItemsOf(page).nth(3)).toContainText(agentReplyText)
  })
})

test.describe('7. chats are independent', () => {
  test('keeps each chat messages separate and persistent while switching', async ({ page }) => {
    await openChat(page, 'Welcome')
    await sendMessage(page, 'Only for Welcome')

    await openChat(page, 'Standup')
    await expect(messageContaining(page, 'Only for Welcome')).toHaveCount(0)
    await expect(messageContaining(page, 'Standup at 10.')).toBeVisible()

    await openChat(page, 'Welcome')
    await expect(messageContaining(page, 'Only for Welcome')).toBeVisible()
  })
})

test.describe('8. message menu', () => {
  test('offers the three actions, with edit and delete enabled on own messages', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))

    await expect(page.getByRole('menuitem', { name: 'Start runtime from this message' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeEnabled()
  })

  test('disables edit and delete on messages of other members', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Welcome to the team!'))

    await expect(page.getByRole('menuitem', { name: 'Start runtime from this message' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeDisabled()
  })

  test('reveals the menu button on keyboard focus', async ({ page }) => {
    await openChat(page, 'Welcome')
    const messageActionsButton = messageContaining(page, 'Thanks, glad to be here.').getByRole('button', {
      name: 'Message actions',
    })
    await messageActionsButton.focus()
    await expect(messageActionsButton).toBeVisible()
  })

  test('has no message menu in a runtime chat', async ({ page }) => {
    await openChat(page, 'Invoice bug')
    await expect(page.getByRole('button', { name: 'Message actions' })).toHaveCount(0)
  })
})

test.describe('9. start a runtime from a message', () => {
  test('creates a runtime chat in the same project, seeded and selected', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()

    const onboardingGroup = sidebarOf(page).getByRole('group', { name: 'Onboarding' })
    await expect(onboardingGroup.getByRole('link', { name: 'Thanks, glad to be here.' })).toBeVisible()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Thanks, glad to be here.' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Runtime view')
    await expect(mainOf(page)).toContainText('Agent acts as Alice')
    await expect(mainOf(page)).toContainText('Claude Sonnet 5.5 · Medium')
    await expect(mainOf(page).getByRole('img', { name: 'Git branch' })).toHaveCount(0)
    await expect(messageItemsOf(page).nth(0)).toContainText('Thanks, glad to be here.')
  })

  test('links back to the source channel and sends nothing to the agent', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()

    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await page.waitForTimeout(1500)
    await expect(messageContaining(page, agentReplyText)).toHaveCount(0)

    await mainOf(page).getByRole('link', { name: 'Started from Welcome' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Channel view')
  })

  test('creates a loose runtime chat from a message of a loose channel', async ({ page }) => {
    await openChat(page, 'Standup')
    await openMessageMenu(messageContaining(page, 'Standup at 10.'))
    await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()

    const looseChatsGroup = sidebarOf(page).getByRole('group', { name: 'Loose chats' })
    await expect(looseChatsGroup.getByRole('link', { name: 'Standup at 10.' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Runtime view')
  })
})

test.describe('10. edit a message', () => {
  const startEditing = async (page: Page) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Edit' }).click()
  }

  test('prefills the text and saves the edit with an edited marker', async ({ page }) => {
    await startEditing(page)
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

  test('keeps the original text on cancel', async ({ page }) => {
    await startEditing(page)
    await page.getByRole('textbox', { name: 'Edit message' }).fill('Something else')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(messageContaining(page, 'Thanks, glad to be here.')).not.toContainText('(edited)')
    await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
  })

  test('cannot save a blank text', async ({ page }) => {
    await startEditing(page)
    await page.getByRole('textbox', { name: 'Edit message' }).fill('   ')
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

test.describe('11. delete a message', () => {
  const startDeleting = async (page: Page) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Delete' }).click()
  }

  test('replaces the message with a tombstone after confirmation', async ({ page }) => {
    await startDeleting(page)
    await page.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Delete' }).click()

    await expect(messageContaining(page, 'This message was deleted')).toBeVisible()
    await expect(messageContaining(page, 'Thanks, glad to be here.')).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(2)
  })

  test('keeps the message when the deletion is cancelled', async ({ page }) => {
    await startDeleting(page)
    await page.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog', { name: 'Delete message' })).toHaveCount(0)
    await expect(messageContaining(page, 'Thanks, glad to be here.')).toBeVisible()
  })
})

test.describe('12. drafts', () => {
  const draftIconOf = (page: Page, chatName: string) =>
    sidebarChatLink(page, chatName).getByRole('img', { name: 'Has unsent draft' })

  test('keeps a draft per chat when switching and shows a pencil in the sidebar', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('Work in progress')
    await expect(draftIconOf(page, 'Welcome')).toBeVisible()

    await openChat(page, 'Standup')
    await expect(composerOf(page)).toHaveValue('')
    await expect(draftIconOf(page, 'Welcome')).toBeVisible()
    await expect(draftIconOf(page, 'Standup')).toHaveCount(0)

    await openChat(page, 'Welcome')
    await expect(composerOf(page)).toHaveValue('Work in progress')
  })

  test('clears the draft and the pencil when the message is sent', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('To be sent')
    await expect(draftIconOf(page, 'Welcome')).toBeVisible()

    await composerOf(page).press('ControlOrMeta+Enter')
    await expect(draftIconOf(page, 'Welcome')).toHaveCount(0)
  })

  test('shows no pencil for a whitespace-only draft', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('   ')
    await expect(draftIconOf(page, 'Welcome')).toHaveCount(0)
  })

  test('places the pencil at the right end of the row, before the menu button', async ({ page }) => {
    await openChat(page, 'Welcome')
    await composerOf(page).fill('Draft')

    const chatNameBox = await sidebarChatLink(page, 'Welcome').getByText('Welcome', { exact: true }).boundingBox()
    const pencilBox = await draftIconOf(page, 'Welcome').boundingBox()
    const menuButtonBox = await page.getByRole('button', { name: 'Chat actions for Welcome' }).boundingBox()
    expect(pencilBox!.x).toBeGreaterThan(chatNameBox!.x + chatNameBox!.width)
    expect(pencilBox!.x + pencilBox!.width).toBeLessThanOrEqual(menuButtonBox!.x)
  })
})

test.describe('13. focus on open', () => {
  test('moves focus to the composer when a chat is opened from the sidebar', async ({ page }) => {
    await sidebarChatLink(page, 'Welcome').click()
    await expect(composerOf(page)).toBeFocused()

    await sidebarChatLink(page, 'Invoice bug').click()
    await expect(composerOf(page)).toBeFocused()
  })

  test('moves focus to the composer of a chat started from a message', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()
    await expect(composerOf(page)).toBeFocused()
  })
})

test.describe('14. dialog colors in dark mode', () => {
  test('uses the text color of the app for the delete message dialog title', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    const dialogTitleColor = await page
      .getByRole('dialog', { name: 'Delete message' })
      .getByRole('heading', { name: 'Delete message' })
      .evaluate((element) => getComputedStyle(element).color)
    const pageTitleColor = await mainOf(page)
      .getByRole('heading', { level: 1 })
      .evaluate((element) => getComputedStyle(element).color)
    expect(dialogTitleColor).toBe(pageTitleColor)
  })
})

test.describe('16. renamed chats elsewhere', () => {
  test('shows the new name in the started-from link of a runtime chat', async ({ page }) => {
    await openChat(page, 'Welcome')
    await openMessageMenu(messageContaining(page, 'Thanks, glad to be here.'))
    await page.getByRole('menuitem', { name: 'Start runtime from this message' }).click()
    await expect(mainOf(page).getByRole('link', { name: 'Started from Welcome' })).toBeVisible()

    await page.getByRole('button', { name: 'Chat actions for Welcome' }).click()
    await page.getByRole('menuitem', { name: 'Rename chat' }).click()
    await page.getByRole('textbox', { name: 'Chat name' }).fill('Greetings')
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(mainOf(page).getByRole('link', { name: 'Started from Greetings' })).toBeVisible()
  })
})
