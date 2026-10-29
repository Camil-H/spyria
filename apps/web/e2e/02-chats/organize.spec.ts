import {
  chatAction,
  chatRowIn,
  expect,
  looseChatsOf,
  mainOf,
  type Page,
  projectAction,
  projectGroupOf,
  sidebarOf,
  test,
} from './fixtures'

const moveChatTo = async (page: Page, chatName: string, destination: string) => {
  await chatAction(page, chatName, 'Move to')
  await page.getByRole('menuitem', { name: destination }).click()
}

const createProjectNamed = async (page: Page, projectName: string) => {
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByRole('textbox', { name: 'Project name' }).fill(projectName)
  await page.getByRole('button', { name: 'Confirm' }).click()
}

const dialogOf = (page: Page, dialogName: string) => page.getByRole('dialog', { name: dialogName })
const cancelDialog = async (page: Page, dialogName: string) => {
  await dialogOf(page, dialogName).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialogOf(page, dialogName)).toHaveCount(0)
}
const archiveChat = async (page: Page, chatName: string) => {
  await chatAction(page, chatName, 'Archive chat')
  await dialogOf(page, 'Archive chat').getByRole('button', { name: 'Archive' }).click()
}
const renameChat = async (page: Page, chatName: string, newName: string) => {
  await chatAction(page, chatName, 'Rename chat')
  await dialogOf(page, 'Rename chat').getByRole('textbox', { name: 'Chat name' }).fill(newName)
}

test.describe('Organize', () => {
  test.use({ runtimeHost: false, warmRuntimes: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I see my projects with their chats and the loose chats, and collapse or expand a project', async ({
    page,
  }) => {
    await test.step('shows projects with their chats and a separate loose chats group', async () => {
      await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')).toBeVisible()
      await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Setup helper')).toBeVisible()
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')).toBeVisible()
      await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
      await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
    })

    await test.step('collapses and expands a project on click', async () => {
      const billingToggle = sidebarOf(page).getByRole('button', { name: 'Billing', exact: true })
      await expect(billingToggle).toHaveAttribute('aria-expanded', 'true')
      await billingToggle.click()
      await expect(billingToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toBeHidden()
      await billingToggle.click()
      await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toBeVisible()
    })
  })

  test('As a member, I cancel or leave blank the new, rename, move and archive dialogs and nothing changes', async ({
    page,
  }) => {
    await test.step('lists the projects and "No project" as destinations', async () => {
      await chatAction(page, 'Research', 'Move to')
      await expect(page.getByRole('menuitem', { name: 'Onboarding' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Billing' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'No project' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menuitem')).toHaveCount(0)
    })

    await test.step('new project: cannot confirm a blank name', async () => {
      await page.getByRole('button', { name: 'New project' }).click()
      await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
      await page.getByRole('textbox', { name: 'Project name' }).fill('   ')
      await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
      await cancelDialog(page, 'New project')
    })

    await test.step('new chat: cannot confirm a blank name', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      await page.getByRole('radio', { name: 'Channel' }).check()
      await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
      await page.getByRole('textbox', { name: 'Chat name' }).fill('   ')
      await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
      await cancelDialog(page, 'New chat')
    })

    await test.step('rename chat: opens a dialog prefilled with the current name', async () => {
      await chatAction(page, 'Research', 'Rename chat')
      await expect(dialogOf(page, 'Rename chat').getByRole('textbox', { name: 'Chat name' })).toHaveValue('Research')
      await expect(dialogOf(page, 'Rename chat').getByRole('textbox', { name: 'Chat name' })).toBeFocused()
    })

    await test.step('rename chat: cannot confirm a blank name', async () => {
      await dialogOf(page, 'Rename chat').getByRole('textbox', { name: 'Chat name' }).fill('   ')
      await expect(dialogOf(page, 'Rename chat').getByRole('button', { name: 'Confirm' })).toBeDisabled()
    })

    await test.step('rename chat: keeps the old name when cancelled', async () => {
      await dialogOf(page, 'Rename chat').getByRole('textbox', { name: 'Chat name' }).fill('Something else')
      await cancelDialog(page, 'Rename chat')
      await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
    })

    await test.step('rename project: opens a dialog prefilled with the current name', async () => {
      await projectAction(page, 'Billing', 'Rename project')
      const projectNameBox = dialogOf(page, 'Rename project').getByRole('textbox', { name: 'Project name' })
      await expect(projectNameBox).toHaveValue('Billing')
      await expect(projectNameBox).toBeFocused()
    })

    await test.step('rename project: cannot confirm a blank name', async () => {
      await dialogOf(page, 'Rename project').getByRole('textbox', { name: 'Project name' }).fill('   ')
      await expect(dialogOf(page, 'Rename project').getByRole('button', { name: 'Confirm' })).toBeDisabled()
    })

    await test.step('rename project: keeps the old name when cancelled', async () => {
      await dialogOf(page, 'Rename project').getByRole('textbox', { name: 'Project name' }).fill('Something else')
      await cancelDialog(page, 'Rename project')
      await expect(projectGroupOf(page, 'Billing')).toBeVisible()
    })

    await test.step('keeps the chat when the archive is cancelled', async () => {
      await chatAction(page, 'Research', 'Archive chat')
      await cancelDialog(page, 'Archive chat')
      await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()
    })
  })

  test('As a member, I move chats between projects and the open chat stays selected', async ({ page }) => {
    await test.step('keeps the selected chat selected after it moves', async () => {
      await chatRowIn(looseChatsOf(page), 'Research').click()
      const urlBeforeMove = page.url()
      await moveChatTo(page, 'Research', 'Billing')
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
      expect(page.url()).toBe(urlBeforeMove)
    })

    await test.step('moves a loose chat into a project', async () => {
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Research')).toBeVisible()
      await expect(chatRowIn(looseChatsOf(page), 'Research')).toHaveCount(0)
    })

    await test.step('moves a chat out of its project', async () => {
      await moveChatTo(page, 'Invoice bug', 'No project')
      await expect(chatRowIn(looseChatsOf(page), 'Invoice bug')).toBeVisible()
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')).toHaveCount(0)
    })

    await test.step('moves a chat between projects', async () => {
      await moveChatTo(page, 'Welcome', 'Billing')
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Welcome')).toBeVisible()
      await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')).toHaveCount(0)
    })
  })

  test('As a member, I create projects, channels and runtime chats', { tag: ['@smoke'] }, async ({ page }) => {
    await test.step('adds an empty project to the list', async () => {
      await createProjectNamed(page, 'Marketing')
      await expect(projectGroupOf(page, 'Marketing')).toBeVisible()
      await expect(projectGroupOf(page, 'Marketing').getByRole('link')).toHaveCount(0)
    })

    await test.step('creates a channel inside a project and selects it', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      await page.getByRole('radio', { name: 'Channel' }).check()
      await page.getByRole('textbox', { name: 'Chat name' }).fill('Planning')
      await page.getByRole('combobox', { name: 'Project' }).selectOption('Billing')
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Planning')).toBeVisible()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible()
      await expect(mainOf(page).getByRole('img', { name: 'Channel' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Channel view')
    })

    await test.step('starts a chat from a project’s menu with that project already chosen', async () => {
      await projectAction(page, 'Billing', 'New chat')
      await expect(page.getByRole('combobox', { name: 'Project' }).locator('option:checked')).toHaveText('Billing')
      await page.getByRole('textbox', { name: 'Chat name' }).fill('Quarter close')
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Quarter close')).toBeVisible()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Quarter close' })).toBeVisible()
    })

    await test.step('creates a runtime chat without a project as a loose chat', async () => {
      await page.getByRole('button', { name: 'New chat' }).click()
      await page.getByRole('radio', { name: 'Runtime' }).check()
      await page.getByRole('textbox', { name: 'Chat name' }).fill('Scratchpad')
      await page.getByRole('button', { name: 'Confirm' }).click()
      await expect(chatRowIn(looseChatsOf(page), 'Scratchpad')).toBeVisible()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Scratchpad' })).toBeVisible()
      await expect(mainOf(page).getByRole('img', { name: 'Runtime chat' })).toBeVisible()
      await expect(mainOf(page)).not.toContainText('Runtime view')
    })
  })

  test('As a member, I archive a project with its chats and the open chat closes', async ({ page }) => {
    await test.step('returns the main area to its empty state when the selected chat is archived', async () => {
      await chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug').click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Invoice bug' })).toBeVisible()
      await projectAction(page, 'Billing', 'Archive project')
      await page.getByRole('button', { name: 'Archive with its chats' }).click()
      await expect(mainOf(page).getByRole('heading', { level: 1 })).toHaveCount(0)
      await expect(mainOf(page)).toContainText('Select a chat')
    })

    await test.step('archives the project with its chats', async () => {
      await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
      await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toHaveCount(0)
    })
  })

  test('As a member, I archive a project and keep its chats as loose chats', async ({ page }) => {
    await projectAction(page, 'Billing', 'Archive project')
    await page.getByRole('button', { name: 'Archive, keep chats' }).click()
    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Invoice bug')).toBeVisible()
  })

  test('As a member, I archive a chat after confirmation', async ({ page }) => {
    await test.step('returns the main area to its empty state when the selected chat is archived by itself', async () => {
      await chatRowIn(looseChatsOf(page), 'Research').click()
      await archiveChat(page, 'Research')
      await expect(mainOf(page)).toContainText('Select a chat')
    })

    await test.step('archives a loose chat after confirmation', async () => {
      await expect(sidebarOf(page).getByRole('link', { name: 'Research' })).toHaveCount(0)
      await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
    })

    await test.step('archives a chat of a project with Enter, the confirmation opening on Archive, and keeps the project', async () => {
      await chatAction(page, 'Invoice bug', 'Archive chat')
      await expect(dialogOf(page, 'Archive chat').getByRole('button', { name: 'Archive' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toHaveCount(0)
      await expect(projectGroupOf(page, 'Billing')).toBeVisible()
    })
  })

  test('As a member, I rename a chat in place, in its project and in the open header', async ({ page }) => {
    await test.step('updates the header of the open chat and keeps it selected', async () => {
      await chatRowIn(looseChatsOf(page), 'Research').click()
      const urlBeforeRename = page.url()
      await renameChat(page, 'Research', '  Market research  ')
      await dialogOf(page, 'Rename chat').getByRole('button', { name: 'Confirm' }).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Market research' })).toBeVisible()
      expect(page.url()).toBe(urlBeforeRename)
    })

    await test.step('renames a loose chat in place', async () => {
      await expect(chatRowIn(looseChatsOf(page), 'Market research')).toBeVisible()
      await expect(sidebarOf(page).getByRole('link', { name: 'Research', exact: true })).toHaveCount(0)
      await expect(dialogOf(page, 'Rename chat')).toHaveCount(0)
    })

    await test.step('renames a chat of a project and keeps it in the project', async () => {
      await renameChat(page, 'Invoice bug', 'Invoice total bug')
      await dialogOf(page, 'Rename chat').getByRole('button', { name: 'Confirm' }).click()
      await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice total bug')).toBeVisible()
    })

    await test.step('confirms with Enter', async () => {
      await renameChat(page, 'Market research', 'Deep research')
      await page.keyboard.press('Enter')
      await expect(chatRowIn(looseChatsOf(page), 'Deep research')).toBeVisible()
    })
  })

  test('As a member, I rename a project: its chats stay in it and the new name is a move destination', async ({
    page,
  }) => {
    const projectNameBox = dialogOf(page, 'Rename project').getByRole('textbox', { name: 'Project name' })

    await test.step('renames the project and keeps its chats in it', async () => {
      await projectAction(page, 'Billing', 'Rename project')
      await projectNameBox.fill('  Invoicing  ')
      await dialogOf(page, 'Rename project').getByRole('button', { name: 'Confirm' }).click()
      await expect(projectGroupOf(page, 'Invoicing')).toBeVisible()
      await expect(chatRowIn(projectGroupOf(page, 'Invoicing'), 'Invoice bug')).toBeVisible()
      await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
      await expect(dialogOf(page, 'Rename project')).toHaveCount(0)
    })

    await test.step('confirms with Enter and shows the new name as a destination of the move menu', async () => {
      await projectAction(page, 'Invoicing', 'Rename project')
      await projectNameBox.fill('Billing and invoicing')
      await page.keyboard.press('Enter')
      await moveChatTo(page, 'Research', 'Billing and invoicing')
      await expect(chatRowIn(projectGroupOf(page, 'Billing and invoicing'), 'Research')).toBeVisible()
    })
  })
})
