import { openPageAs } from '../stack'
import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chipOf,
  chooseRoleAction,
  createRole,
  deleteDialogOf,
  deleteRole,
  editRole,
  expect,
  expectMembers,
  giveWorkspaceRole,
  insertRole,
  insertWorkspaceRole,
  mainOf,
  messageContaining,
  newRuntimeChat,
  openChat,
  openChatRoles,
  openPanelTab,
  openRoles,
  type Page,
  panelTabOf,
  permissionsOfRole,
  permissionsOfRoleIn,
  roleColumnIn,
  roleItemOf,
  sendButtonOf,
  sendMessage,
  sessionOf,
  sidebarOf,
  tabPanelOf,
  test,
} from './fixtures'

const readerNotice = 'You can read this chat'
const workspaceRolesOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Workspace roles' })
const workspaceRoleItemOf = (page: Page, name: string) => roleColumnIn(workspaceRolesOf(page), name)
const settingsLinkOf = (page: Page) => sidebarOf(page).getByRole('link', { name: 'Workspace settings' })
const memberRoleSelectOf = (page: Page, name: string) =>
  mainOf(page)
    .getByRole('region', { name: 'Members' })
    .getByRole('combobox', { name: `Role of ${name}` })
test.describe('Roles', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member who can manage roles, I create a chat role with read and session configuration: it is listed in plain words, and built-in roles have no edit controls', {
    tag: ['@spec-47'],
  }, async ({ page }) => {
    await createRole(page, 'Reviewer', ['Choose the model and stop the agent'])
    await expect
      .poll(() => permissionsOfRole(page, 'Reviewer'))
      .toEqual(['Read the chat', 'Choose the model and stop the agent'])
    await expect(roleItemOf(page, 'Reviewer').getByRole('button', { name: 'Actions for Reviewer' })).toBeVisible()
    for (const builtInName of ['Owner', 'Editor', 'Prompter', 'Reader'])
      await expect(roleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)
    await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(mainOf(page).getByRole('link', { name: 'Members and roles', exact: true })).toContainText(
      '1 custom role',
    )
  })

  test('As a chat owner, I give Lee a custom role from the Members tab: his session window becomes editable while his composer stays blocked', {
    tag: ['@spec-47'],
  }, async ({ page, browser, workerStack }) => {
    await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
    const chatId = await newRuntimeChat(page, 'Lee reviews')
    await addParticipant(workerStack, chatId, 'member-lee', 'reader')
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await addLlmKey(leePage, 'Mistral')
    await openChat(leePage, 'Lee reviews')
    await chipOf(leePage, 'any').click()
    await expect(sessionOf(leePage).getByLabel('Subagents')).toBeDisabled()

    await panelTabOf(page, 'Members').click()
    await tabPanelOf(page).getByLabel('Role of Lee').selectOption({ label: 'Reviewer' })
    await expectMembers(page, [
      ['Alice', 'Owner'],
      ['Lee', 'Reviewer'],
    ])
    await expect(sessionOf(leePage).getByLabel('Subagents')).toBeEnabled()
    await expect(mainOf(leePage)).toContainText(readerNotice)
    await expect(sendButtonOf(leePage)).toBeDisabled()
    await leePage.context().close()
  })

  test('As a member who can manage roles, I add Post to a role: its holder’s composer unblocks without a reload and his prompt is answered', {
    tag: ['@spec-47', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
    const chatId = await newRuntimeChat(page, 'Lee posts')
    await addParticipant(workerStack, chatId, 'member-lee', 'role-reviewer')
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await addLlmKey(leePage, 'Mistral')
    await openChat(leePage, 'Lee posts')
    await expect(mainOf(leePage)).toContainText(readerNotice)

    await openChatRoles(page)
    await editRole(page, 'Reviewer', ['Post and prompt the agent'])
    await expect.poll(() => permissionsOfRole(page, 'Reviewer')).toContain('Post and prompt the agent')
    await expect(mainOf(leePage)).not.toContainText(readerNotice)
    await sendMessage(leePage, 'Lee asks now')
    await expect(messageContaining(leePage, agentReplyText)).toHaveCount(1)
    await leePage.context().close()
  })

  test('As a member who can manage roles, I cannot delete a chat role Lee holds; once he is a Reader again it is deleted', {
    tag: ['@spec-47'],
  }, async ({ page, workerStack }) => {
    await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
    const chatId = await newRuntimeChat(page, 'Lee holds a role')
    await addParticipant(workerStack, chatId, 'member-lee', 'role-reviewer')
    await openChatRoles(page)
    await deleteRole(page, 'Reviewer')
    await expect(deleteDialogOf(page)).toContainText('Reviewer is held by 1 member in 1 chat; change their role first')
    await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(roleItemOf(page, 'Reviewer')).toBeVisible()

    await openPanelTab(page, 'Lee holds a role', 'Members')
    await tabPanelOf(page).getByLabel('Role of Lee').selectOption({ label: 'Reader' })
    await expectMembers(page, [
      ['Alice', 'Owner'],
      ['Lee', 'Reader'],
    ])
    await openChatRoles(page)
    await deleteRole(page, 'Reviewer')
    await expect(roleItemOf(page, 'Reviewer')).toHaveCount(0)
  })

  test('As a member who can manage roles, I create a Finance workspace role with costs and budgets and give it to Bob: he sees only Costs, without a reload, and is refused the other settings pages', {
    tag: ['@spec-50', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await expect(sidebarOf(bobPage).getByRole('link', { name: 'Profile' })).toBeVisible()
    await expect(settingsLinkOf(bobPage)).toHaveCount(0)

    await openRoles(page, 'Workspace roles')
    await workspaceRolesOf(page).getByRole('button', { name: 'New role' }).click()
    const form = page.getByRole('form', { name: 'New role' })
    await form.getByRole('textbox', { name: 'Name' }).fill('Finance')
    for (const permissionLabel of ['View costs', 'Manage budgets']) await form.getByLabel(permissionLabel).check()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect
      .poll(() => permissionsOfRoleIn(workspaceRolesOf(page), 'Finance'))
      .toEqual(['View costs', 'Manage budgets'])
    await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
    await mainOf(page).getByRole('link', { name: 'Members and roles', exact: true }).click()
    await memberRoleSelectOf(page, 'Bob').selectOption({ label: 'Finance' })

    await settingsLinkOf(bobPage).click()
    await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
    const bobsCards = mainOf(bobPage).getByRole('region').getByRole('link')
    await expect(bobsCards).toHaveCount(1)
    await expect(bobsCards).toHaveAccessibleName('Costs')
    await bobsCards.click()
    await expect(mainOf(bobPage).getByRole('region', { name: 'Budgets' })).toBeVisible()
    await expect(mainOf(bobPage).getByRole('region', { name: 'Usage' })).toBeVisible()
    for (const card of ['team', 'audit', 'runtime']) {
      await bobPage.goto(`/w/workspace-acme/settings/${card}`)
      await expect(mainOf(bobPage)).toContainText('Your workspace role does not give access to this page')
    }
    await bobPage.context().close()
  })

  test('As a member who can manage roles, I cannot delete a workspace role Bob holds; once he is a Member again, it is deleted', {
    tag: ['@spec-50'],
  }, async ({ page, workerStack }) => {
    await insertWorkspaceRole(workerStack, 'role-finance', 'Finance', ['costs.view'])
    await giveWorkspaceRole(workerStack, 'member-bob', 'role-finance')
    await openRoles(page, 'Workspace roles')
    await chooseRoleAction(workspaceRolesOf(page), 'Finance', 'Delete')
    await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
    await expect(deleteDialogOf(page)).toContainText('Finance is held by 1 member; change their role first')
    await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(workspaceRoleItemOf(page, 'Finance')).toBeVisible()

    await mainOf(page).getByRole('tab', { name: 'Members' }).click()
    await memberRoleSelectOf(page, 'Bob').selectOption({ label: 'Member' })
    await expect(memberRoleSelectOf(page, 'Bob')).toHaveValue('member')
    await mainOf(page).getByRole('tab', { name: 'Roles' }).click()
    await chooseRoleAction(workspaceRolesOf(page), 'Finance', 'Delete')
    await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
    await expect(workspaceRoleItemOf(page, 'Finance')).toHaveCount(0)
  })

  test('As a member who can manage roles, I see Workspace roles and Chat roles as two permission grids whose built-in roles are read-only', {
    tag: ['@spec-50'],
  }, async ({ page }) => {
    await openRoles(page, 'Workspace roles')
    await expect(mainOf(page).getByRole('radiogroup', { name: 'Role lists' }).getByRole('radio')).toHaveCount(2)
    await expect(workspaceRolesOf(page).getByRole('table').getByRole('columnheader')).toHaveText([
      'Permission',
      /^Admin/,
      /^Member/,
    ])
    await expect
      .poll(() => permissionsOfRoleIn(workspaceRolesOf(page), 'Admin'))
      .toEqual([
        'Invite members',
        'Change roles and remove members',
        'Manage roles',
        'Set up SSO',
        'Connect GitHub',
        'Manage the tools catalogue',
        'Manage AI providers',
        'Manage runtime hosts and local sessions',
        'View costs',
        'Manage budgets',
        'View the audit log',
      ])
    await expect.poll(() => permissionsOfRoleIn(workspaceRolesOf(page), 'Member')).toEqual([])
    for (const builtInName of ['Admin', 'Member'])
      await expect(workspaceRoleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)

    await mainOf(page).getByRole('radio', { name: 'Chat roles' }).check()
    await expect(workspaceRolesOf(page)).toHaveCount(0)
    await expect(mainOf(page).getByRole('region', { name: 'Chat roles' }).getByRole('columnheader')).toHaveCount(5)
    await expect.poll(() => permissionsOfRole(page, 'Reader')).toEqual(['Read the chat'])
    await expect.poll(() => permissionsOfRole(page, 'Owner')).toContain('Change roles and remove people')
    for (const builtInName of ['Owner', 'Editor', 'Prompter', 'Reader'])
      await expect(roleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)
  })

  test('As a member whose role only manages roles, I open Members and roles straight onto the permission grid, without a Members tab', {
    tag: ['@spec-50'],
  }, async ({ browser, workerStack }) => {
    await insertWorkspaceRole(workerStack, 'role-keeper', 'Role keeper', ['roles.manage'])
    await giveWorkspaceRole(workerStack, 'member-bob', 'role-keeper')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await settingsLinkOf(bobPage).click()
    const bobsCards = mainOf(bobPage).getByRole('region').getByRole('link')
    await expect(bobsCards).toHaveCount(1)
    await expect(bobsCards).toHaveAccessibleName('Members and roles')
    await bobsCards.click()

    await expect(mainOf(bobPage).getByRole('tablist', { name: 'Members and roles' })).toHaveCount(0)
    await expect(mainOf(bobPage).getByRole('region', { name: 'Members' })).toHaveCount(0)
    const workspaceRoles = mainOf(bobPage).getByRole('region', { name: 'Workspace roles' })
    await expect(roleColumnIn(workspaceRoles, 'Role keeper')).toBeVisible()
    await expect.poll(() => permissionsOfRoleIn(workspaceRoles, 'Role keeper')).toEqual(['Manage roles'])
    await expect(workspaceRoles.getByRole('button', { name: 'New role' })).toBeVisible()
    await bobPage.context().close()
  })
})
