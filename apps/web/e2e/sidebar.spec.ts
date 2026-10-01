import { expect, type Page, test } from '@playwright/test'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const projectGroupOf = (page: Page, projectName: string) => sidebarOf(page).getByRole('group', { name: projectName })
const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
const chatRowIn = (group: ReturnType<typeof projectGroupOf>, chatName: string) =>
  group.getByRole('link', { name: chatName })
const mainOf = (page: Page) => page.getByRole('main')

const moveChatTo = async (page: Page, chatName: string, destination: string) => {
  await page.getByRole('button', { name: `Chat actions for ${chatName}` }).click()
  await page.getByRole('menuitem', { name: 'Move to' }).click()
  await page.getByRole('menuitem', { name: destination }).click()
}

const createProjectNamed = async (page: Page, projectName: string) => {
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill(projectName)
  await page.getByRole('button', { name: 'Confirm' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('1. switch workspace', () => {
  test('lists both workspaces and shows only the selected workspace content', async ({ page }) => {
    await page.getByRole('button', { name: 'Switch workspace' }).click()
    await expect(page.getByRole('menuitem', { name: 'Acme' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Globex' })).toBeVisible()

    await page.getByRole('menuitem', { name: 'Globex' }).click()

    await expect(chatRowIn(projectGroupOf(page, 'Launch'), 'Launch plan')).toBeVisible()
    await expect(chatRowIn(looseChatsOf(page), 'General')).toBeVisible()
    await expect(projectGroupOf(page, 'Onboarding')).toHaveCount(0)
    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('link', { name: 'Standup' })).toHaveCount(0)
  })
})

test.describe('2. tree structure', () => {
  test('shows projects with their chats and a separate loose chats group', async ({ page }) => {
    await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')).toBeVisible()
    await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Setup helper')).toBeVisible()
    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')).toBeVisible()
    await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
    await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
  })

  test('collapses and expands a project on click', async ({ page }) => {
    const billingToggle = sidebarOf(page).getByRole('button', { name: 'Billing', exact: true })
    await expect(billingToggle).toHaveAttribute('aria-expanded', 'true')

    await billingToggle.click()
    await expect(billingToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toBeHidden()

    await billingToggle.click()
    await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toBeVisible()
  })
})

test.describe('3. chat rows and selection', () => {
  test('hints the chat type with an icon and shows no type text or owner name', async ({ page }) => {
    const invoiceBugRow = chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')
    await expect(invoiceBugRow.getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(invoiceBugRow).toHaveText('Invoice bug')

    const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
    await expect(welcomeRow.getByRole('img', { name: 'Channel' })).toBeVisible()
    await expect(welcomeRow).toHaveText('Welcome')
    await expect(sidebarOf(page)).not.toContainText('Bob')
  })

  test('explains the chat type in a tooltip when hovering its icon', async ({ page }) => {
    await chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug').getByRole('img', { name: 'Runtime chat' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Runtime chat' })).toBeVisible()

    await chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome').getByRole('img', { name: 'Channel' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Channel' })).toBeVisible()
  })

  test('opens a runtime chat in the runtime view', async ({ page }) => {
    await chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug').click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Runtime view')
  })

  test('opens a channel in the channel view', async ({ page }) => {
    await chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome').click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Channel view')
  })
})

test.describe('4. move a chat', () => {
  test('lists the projects and "No project" as destinations', async ({ page }) => {
    await page.getByRole('button', { name: 'Chat actions for Research' }).click()
    await page.getByRole('menuitem', { name: 'Move to' }).click()
    await expect(page.getByRole('menuitem', { name: 'Onboarding' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Billing' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'No project' })).toBeVisible()
  })

  test('moves a loose chat into a project', async ({ page }) => {
    await moveChatTo(page, 'Research', 'Billing')
    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Research')).toBeVisible()
    await expect(chatRowIn(looseChatsOf(page), 'Research')).toHaveCount(0)
  })

  test('moves a chat out of its project', async ({ page }) => {
    await moveChatTo(page, 'Invoice bug', 'No project')
    await expect(chatRowIn(looseChatsOf(page), 'Invoice bug')).toBeVisible()
    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')).toHaveCount(0)
  })

  test('moves a chat between projects', async ({ page }) => {
    await moveChatTo(page, 'Welcome', 'Billing')
    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Welcome')).toBeVisible()
    await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')).toHaveCount(0)
  })

  test('keeps the selected chat selected after it moves', async ({ page }) => {
    await chatRowIn(looseChatsOf(page), 'Research').click()
    const urlBeforeMove = page.url()

    await moveChatTo(page, 'Research', 'Billing')

    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
    expect(page.url()).toBe(urlBeforeMove)
  })
})

test.describe('5. create a project', () => {
  test('adds an empty project to the list', async ({ page }) => {
    await createProjectNamed(page, 'Marketing')
    await expect(projectGroupOf(page, 'Marketing')).toBeVisible()
    await expect(projectGroupOf(page, 'Marketing').getByRole('link')).toHaveCount(0)
  })

  test('cannot confirm a blank name', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click()
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Project name' }).fill('   ')
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })
})

test.describe('6. archive a project', () => {
  const openArchiveChoices = async (page: Page, projectName: string) => {
    await page.getByRole('button', { name: `Project actions for ${projectName}` }).click()
    await page.getByRole('menuitem', { name: 'Archive project' }).click()
  }

  test('archives the project with its chats', async ({ page }) => {
    await openArchiveChoices(page, 'Billing')
    await page.getByRole('button', { name: 'Archive with its chats' }).click()

    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toHaveCount(0)
  })

  test('archives the project and releases its chats as loose chats', async ({ page }) => {
    await openArchiveChoices(page, 'Billing')
    await page.getByRole('button', { name: 'Archive, keep chats' }).click()

    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Invoice bug')).toBeVisible()
  })

  test('returns the main area to its empty state when the selected chat is archived', async ({ page }) => {
    await chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug').click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' })).toBeVisible()

    await openArchiveChoices(page, 'Billing')
    await page.getByRole('button', { name: 'Archive with its chats' }).click()

    await expect(mainOf(page).getByRole('heading', { level: 1 })).toHaveCount(0)
    await expect(mainOf(page)).toContainText('Select a chat')
  })

  const openArchiveChatDialog = async (page: Page, chatName: string) => {
    await page.getByRole('button', { name: `Chat actions for ${chatName}` }).click()
    await page.getByRole('menuitem', { name: 'Archive chat' }).click()
  }

  test('archives a loose chat after confirmation', async ({ page }) => {
    await openArchiveChatDialog(page, 'Research')
    await page.getByRole('dialog', { name: 'Archive chat' }).getByRole('button', { name: 'Archive' }).click()

    await expect(sidebarOf(page).getByRole('link', { name: 'Research' })).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
  })

  test('archives a chat of a project and keeps the project', async ({ page }) => {
    await openArchiveChatDialog(page, 'Invoice bug')
    await page.getByRole('dialog', { name: 'Archive chat' }).getByRole('button', { name: 'Archive' }).click()

    await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toHaveCount(0)
    await expect(projectGroupOf(page, 'Billing')).toBeVisible()
  })

  test('keeps the chat when the archive is cancelled', async ({ page }) => {
    await openArchiveChatDialog(page, 'Research')
    await page.getByRole('dialog', { name: 'Archive chat' }).getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog', { name: 'Archive chat' })).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
  })

  test('returns the main area to its empty state when the selected chat is archived by itself', async ({ page }) => {
    await chatRowIn(looseChatsOf(page), 'Research').click()
    await openArchiveChatDialog(page, 'Research')
    await page.getByRole('dialog', { name: 'Archive chat' }).getByRole('button', { name: 'Archive' }).click()

    await expect(mainOf(page)).toContainText('Select a chat')
  })
})

test.describe('7. profile', () => {
  test('opens the profile view with the member name', async ({ page }) => {
    await sidebarOf(page).getByRole('link', { name: 'Profile' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    await expect(mainOf(page)).toContainText('Alice')
  })
})

test.describe('8. create a chat', () => {
  const openNewChatDialog = (page: Page) => page.getByRole('button', { name: 'New chat' }).click()

  test('creates a channel inside a project and selects it', async ({ page }) => {
    await openNewChatDialog(page)
    await page.getByRole('radio', { name: 'Channel' }).check()
    await page.getByRole('textbox', { name: 'Chat name' }).fill('Planning')
    await page.getByRole('combobox', { name: 'Project' }).selectOption('Billing')
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Planning')).toBeVisible()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Channel view')
  })

  test('creates a runtime chat without a project as a loose chat', async ({ page }) => {
    await openNewChatDialog(page)
    await page.getByRole('radio', { name: 'Runtime' }).check()
    await page.getByRole('textbox', { name: 'Chat name' }).fill('Scratchpad')
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(chatRowIn(looseChatsOf(page), 'Scratchpad')).toBeVisible()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Scratchpad' })).toBeVisible()
    await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(mainOf(page)).not.toContainText('Runtime view')
  })

  test('offers channel and runtime as one row of options', async ({ page }) => {
    await openNewChatDialog(page)
    const channelOptionBox = await page.getByRole('radio', { name: 'Channel' }).locator('..').boundingBox()
    const runtimeOptionBox = await page.getByRole('radio', { name: 'Runtime' }).locator('..').boundingBox()
    expect(Math.abs(channelOptionBox!.y - runtimeOptionBox!.y)).toBeLessThan(2)
    expect(runtimeOptionBox!.x).toBeGreaterThan(channelOptionBox!.x + channelOptionBox!.width - 1)
  })

  test('cannot confirm a blank name', async ({ page }) => {
    await openNewChatDialog(page)
    await page.getByRole('radio', { name: 'Channel' }).check()
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Chat name' }).fill('   ')
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })
})

test.describe('9. sidebar toolbar', () => {
  for (const actionName of ['New project', 'New chat']) {
    test(`shows ${actionName} as an icon at the top right with a tooltip`, async ({ page }) => {
      const actionButton = sidebarOf(page).getByRole('button', { name: actionName })
      await expect(actionButton).toHaveText('')
      const sidebarBox = await sidebarOf(page).boundingBox()
      const buttonBox = await actionButton.boundingBox()
      expect(buttonBox!.x).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width / 2)
      expect(buttonBox!.y).toBeLessThan(sidebarBox!.y + 60)

      await actionButton.hover()
      await expect(page.getByRole('tooltip', { name: actionName })).toBeVisible()
    })
  }
})

test.describe('10. menu triggers', () => {
  const triggerNames = ['Project actions for Billing', 'Chat actions for Invoice bug']

  test('keeps hovered menu triggers inset from the scroll area edge so their highlight is not clipped', async ({
    page,
  }) => {
    const scrollAreaBox = await looseChatsOf(page).locator('..').boundingBox()
    for (const triggerName of triggerNames) {
      const trigger = sidebarOf(page).getByRole('button', { name: triggerName })
      await trigger.hover()
      const triggerBox = await trigger.boundingBox()
      expect(scrollAreaBox!.x + scrollAreaBox!.width - (triggerBox!.x + triggerBox!.width)).toBeGreaterThanOrEqual(4)
    }
  })
})

test.describe('11. focus rings', () => {
  test('keeps the keyboard focus ring of a chat row inside the row so neighbours are not cut', async ({ page }) => {
    const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
    await welcomeRow.focus()
    await expect(welcomeRow).toHaveCSS('outline-style', 'solid')
    await expect(welcomeRow).toHaveCSS('outline-offset', '-2px')
  })
})

test.describe('12. dialog colors in dark mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
  })

  const expectDialogTitleToUseAppTextColor = async (page: Page, dialogName: string) => {
    const dialogTitleColor = await page
      .getByRole('dialog', { name: dialogName })
      .getByRole('heading', { name: dialogName })
      .evaluate((element) => getComputedStyle(element).color)
    const sidebarTextColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
    expect(dialogTitleColor).toBe(sidebarTextColor)
  }

  test('uses the app text color for the new project and new chat dialogs', async ({ page }) => {
    await page.getByRole('button', { name: 'New project' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'New project')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'New chat' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'New chat')
  })

  test('uses the app text color for the archive dialogs', async ({ page }) => {
    await page.getByRole('button', { name: 'Chat actions for Research' }).click()
    await page.getByRole('menuitem', { name: 'Archive chat' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'Archive chat')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Chat actions for Research' }).click()
    await page.getByRole('menuitem', { name: 'Rename chat' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'Rename chat')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Project actions for Billing' }).click()
    await page.getByRole('menuitem', { name: 'Archive project' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'Archive project')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Project actions for Billing' }).click()
    await page.getByRole('menuitem', { name: 'Rename project' }).click()
    await expectDialogTitleToUseAppTextColor(page, 'Rename project')
  })
})

test.describe('13. rename a chat', () => {
  const openRenameDialog = async (page: Page, chatName: string) => {
    await page.getByRole('button', { name: `Chat actions for ${chatName}` }).click()
    await page.getByRole('menuitem', { name: 'Rename chat' }).click()
  }
  const renameDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Rename chat' })

  test('opens a dialog prefilled with the current name', async ({ page }) => {
    await openRenameDialog(page, 'Research')
    await expect(renameDialogOf(page).getByRole('textbox', { name: 'Chat name' })).toHaveValue('Research')
    await expect(renameDialogOf(page).getByRole('textbox', { name: 'Chat name' })).toBeFocused()
  })

  test('renames a loose chat in place', async ({ page }) => {
    await openRenameDialog(page, 'Research')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('  Market research  ')
    await renameDialogOf(page).getByRole('button', { name: 'Confirm' }).click()

    await expect(chatRowIn(looseChatsOf(page), 'Market research')).toBeVisible()
    await expect(sidebarOf(page).getByRole('link', { name: 'Research', exact: true })).toHaveCount(0)
    await expect(renameDialogOf(page)).toHaveCount(0)
  })

  test('renames a chat of a project and keeps it in the project', async ({ page }) => {
    await openRenameDialog(page, 'Invoice bug')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('Invoice total bug')
    await renameDialogOf(page).getByRole('button', { name: 'Confirm' }).click()

    await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice total bug')).toBeVisible()
  })

  test('updates the header of the open chat and keeps it selected', async ({ page }) => {
    await chatRowIn(looseChatsOf(page), 'Research').click()
    const urlBeforeRename = page.url()

    await openRenameDialog(page, 'Research')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('Market research')
    await renameDialogOf(page).getByRole('button', { name: 'Confirm' }).click()

    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Market research' })).toBeVisible()
    expect(page.url()).toBe(urlBeforeRename)
  })

  test('keeps the old name when cancelled', async ({ page }) => {
    await openRenameDialog(page, 'Research')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('Something else')
    await renameDialogOf(page).getByRole('button', { name: 'Cancel' }).click()

    await expect(renameDialogOf(page)).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
  })

  test('cannot confirm a blank name', async ({ page }) => {
    await openRenameDialog(page, 'Research')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('   ')
    await expect(renameDialogOf(page).getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  test('confirms with Enter', async ({ page }) => {
    await openRenameDialog(page, 'Standup')
    await renameDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('Daily standup')
    await page.keyboard.press('Enter')
    await expect(chatRowIn(looseChatsOf(page), 'Daily standup')).toBeVisible()
  })
})

test.describe('14. rename a project', () => {
  const openRenameProjectDialog = async (page: Page, projectName: string) => {
    await page.getByRole('button', { name: `Project actions for ${projectName}` }).click()
    await page.getByRole('menuitem', { name: 'Rename project' }).click()
  }
  const renameProjectDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Rename project' })

  test('opens a dialog prefilled with the current name', async ({ page }) => {
    await openRenameProjectDialog(page, 'Billing')
    await expect(renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' })).toHaveValue('Billing')
    await expect(renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' })).toBeFocused()
  })

  test('renames the project and keeps its chats in it', async ({ page }) => {
    await openRenameProjectDialog(page, 'Billing')
    await renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' }).fill('  Invoicing  ')
    await renameProjectDialogOf(page).getByRole('button', { name: 'Confirm' }).click()

    await expect(projectGroupOf(page, 'Invoicing')).toBeVisible()
    await expect(chatRowIn(projectGroupOf(page, 'Invoicing'), 'Invoice bug')).toBeVisible()
    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(renameProjectDialogOf(page)).toHaveCount(0)
  })

  test('shows the new name as a destination of the move menu', async ({ page }) => {
    await openRenameProjectDialog(page, 'Billing')
    await renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' }).fill('Invoicing')
    await page.keyboard.press('Enter')

    await moveChatTo(page, 'Research', 'Invoicing')
    await expect(chatRowIn(projectGroupOf(page, 'Invoicing'), 'Research')).toBeVisible()
  })

  test('keeps the old name when cancelled', async ({ page }) => {
    await openRenameProjectDialog(page, 'Billing')
    await renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' }).fill('Something else')
    await renameProjectDialogOf(page).getByRole('button', { name: 'Cancel' }).click()

    await expect(renameProjectDialogOf(page)).toHaveCount(0)
    await expect(projectGroupOf(page, 'Billing')).toBeVisible()
  })

  test('cannot confirm a blank name', async ({ page }) => {
    await openRenameProjectDialog(page, 'Billing')
    await renameProjectDialogOf(page).getByRole('textbox', { name: 'Project name' }).fill('   ')
    await expect(renameProjectDialogOf(page).getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })
})
