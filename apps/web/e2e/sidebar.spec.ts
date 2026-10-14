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
  switcherOf,
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

test.use({ runtimeHost: false, warmRuntimes: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('renders the tree, its rows, toolbar and focus rings, and switches workspace', async ({ page }) => {
  await test.step('keeps the keyboard focus ring of a chat row inside the row so neighbours are not cut', async () => {
    const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
    await welcomeRow.focus()
    await expect(welcomeRow).toHaveCSS('outline-style', 'solid')
    await expect(welcomeRow).toHaveCSS('outline-offset', '-2px')
  })

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

  await test.step('hints the chat type with an icon and shows no type text or owner name', async () => {
    const invoiceBugRow = chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')
    await expect(invoiceBugRow.getByRole('img', { name: 'Runtime chat' })).toBeVisible()
    await expect(invoiceBugRow).toHaveText('Invoice bug')
    const welcomeRow = chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')
    await expect(welcomeRow.getByRole('img', { name: 'Channel' })).toBeVisible()
    await expect(welcomeRow).toHaveText('Welcome')
    await expect(sidebarOf(page)).not.toContainText('Bob')
  })

  await test.step('explains the chat type in a tooltip when hovering its icon', async () => {
    await chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug').getByRole('img', { name: 'Runtime chat' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Runtime chat' })).toBeVisible()
    await chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome').getByRole('img', { name: 'Channel' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Channel' })).toBeVisible()
  })

  for (const actionName of ['New project', 'New chat'])
    await test.step(`shows ${actionName} as an icon at the top right with a tooltip`, async () => {
      const actionButton = sidebarOf(page).getByRole('button', { name: actionName })
      await expect(actionButton).toHaveText('')
      const sidebarBox = await sidebarOf(page).boundingBox()
      const buttonBox = await actionButton.boundingBox()
      expect(buttonBox!.x).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width / 2)
      expect(buttonBox!.y).toBeLessThan(sidebarBox!.y + 60)
      await actionButton.hover()
      await expect(page.getByRole('tooltip', { name: actionName })).toBeVisible()
      await mainOf(page).hover()
      await mainOf(page).hover({ position: { x: 10, y: 10 } })
      await expect(page.getByRole('tooltip')).toHaveCount(0)
    })

  await test.step('keeps hovered menu triggers inset from the scroll area edge so their highlight is not clipped', async () => {
    const scrollAreaBox = await looseChatsOf(page).locator('..').boundingBox()
    for (const triggerName of ['Project actions for Billing', 'Chat actions for Invoice bug']) {
      const trigger = sidebarOf(page).getByRole('button', { name: triggerName })
      await trigger.hover()
      const triggerBox = await trigger.boundingBox()
      expect(scrollAreaBox!.x + scrollAreaBox!.width - (triggerBox!.x + triggerBox!.width)).toBeGreaterThanOrEqual(4)
    }
  })

  await test.step('lists both workspaces and shows only the selected workspace content', async () => {
    await switcherOf(page).click()
    await expect(page.getByRole('menuitem', { name: 'Acme', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Globex', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Globex', exact: true }).click()
    await expect(switcherOf(page)).toContainText('Globex')
    await expect(chatRowIn(projectGroupOf(page, 'Launch'), 'Launch plan')).toBeVisible()
    await expect(chatRowIn(looseChatsOf(page), 'General')).toBeVisible()
    await expect(projectGroupOf(page, 'Onboarding')).toHaveCount(0)
    await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
    await expect(sidebarOf(page).getByRole('link', { name: 'Standup' })).toHaveCount(0)
  })
})

test('dialogs and menus that change nothing', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const expectDialogTitleToUseAppTextColor = async (dialogName: string) => {
    const dialogTitleColor = await dialogOf(page, dialogName)
      .getByRole('heading', { name: dialogName })
      .evaluate((element) => getComputedStyle(element).color)
    const sidebarTextColor = await sidebarOf(page).evaluate((element) => getComputedStyle(element).color)
    expect(dialogTitleColor).toBe(sidebarTextColor)
  }

  await test.step('lists the projects and "No project" as destinations', async () => {
    await chatAction(page, 'Research', 'Move to')
    await expect(page.getByRole('menuitem', { name: 'Onboarding' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Billing' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'No project' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem')).toHaveCount(0)
  })

  await test.step('uses the app text color for the new project and new chat dialogs', async () => {
    await page.getByRole('button', { name: 'New project' }).click()
    await expectDialogTitleToUseAppTextColor('New project')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'New chat' }).click()
    await expectDialogTitleToUseAppTextColor('New chat')
    await cancelDialog(page, 'New chat')
  })

  await test.step('uses the app text color for the archive dialogs', async () => {
    await chatAction(page, 'Research', 'Archive chat')
    await expectDialogTitleToUseAppTextColor('Archive chat')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await chatAction(page, 'Research', 'Rename chat')
    await expectDialogTitleToUseAppTextColor('Rename chat')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await projectAction(page, 'Billing', 'Archive project')
    await expectDialogTitleToUseAppTextColor('Archive project')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await projectAction(page, 'Billing', 'Rename project')
    await expectDialogTitleToUseAppTextColor('Rename project')
    await cancelDialog(page, 'Rename project')
  })

  await test.step('new project: cannot confirm a blank name', async () => {
    await page.getByRole('button', { name: 'New project' }).click()
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Project name' }).fill('   ')
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await cancelDialog(page, 'New project')
  })

  await test.step('offers channel and runtime as one row of options', async () => {
    await page.getByRole('button', { name: 'New chat' }).click()
    const channelOptionBox = await page.getByRole('radio', { name: 'Channel' }).locator('..').boundingBox()
    const runtimeOptionBox = await page.getByRole('radio', { name: 'Runtime' }).locator('..').boundingBox()
    expect(Math.abs(channelOptionBox!.y - runtimeOptionBox!.y)).toBeLessThan(2)
    expect(runtimeOptionBox!.x).toBeGreaterThan(channelOptionBox!.x + channelOptionBox!.width - 1)
  })

  await test.step('new chat: cannot confirm a blank name', async () => {
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

test('moves chats between projects and keeps the selected chat selected', async ({ page }) => {
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

test('creates projects and chats', async ({ page }) => {
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

test('archives a selected project with its chats and empties the main area', async ({ page }) => {
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

test('archives the project and releases its chats as loose chats', async ({ page }) => {
  await projectAction(page, 'Billing', 'Archive project')
  await page.getByRole('button', { name: 'Archive, keep chats' }).click()
  await expect(projectGroupOf(page, 'Billing')).toHaveCount(0)
  await expect(chatRowIn(looseChatsOf(page), 'Invoice bug')).toBeVisible()
})

test('archives chats after confirmation', async ({ page }) => {
  await test.step('returns the main area to its empty state when the selected chat is archived by itself', async () => {
    await chatRowIn(looseChatsOf(page), 'Research').click()
    await archiveChat(page, 'Research')
    await expect(mainOf(page)).toContainText('Select a chat')
  })

  await test.step('archives a loose chat after confirmation', async () => {
    await expect(sidebarOf(page).getByRole('link', { name: 'Research' })).toHaveCount(0)
    await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
  })

  await test.step('archives a chat of a project and keeps the project', async () => {
    await archiveChat(page, 'Invoice bug')
    await expect(sidebarOf(page).getByRole('link', { name: 'Invoice bug' })).toHaveCount(0)
    await expect(projectGroupOf(page, 'Billing')).toBeVisible()
  })
})

test('renames chats in place, in their project and in the open header', async ({ page }) => {
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
    await renameChat(page, 'Standup', 'Daily standup')
    await page.keyboard.press('Enter')
    await expect(chatRowIn(looseChatsOf(page), 'Daily standup')).toBeVisible()
  })
})

test('renames a project, keeps its chats and offers the new name as a destination', async ({ page }) => {
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
