import { openPageAs, type WorkerStack } from '../stack'
import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chipOf,
  expect,
  expectMembers,
  giveWorkspaceRole,
  insertWorkspaceRole,
  mainOf,
  messageContaining,
  newRuntimeChat,
  openChat,
  openPanelTab,
  openSettings,
  type Page,
  panelTabOf,
  sendButtonOf,
  sendMessage,
  sessionOf,
  sidebarOf,
  tabPanelOf,
  test,
} from './fixtures'

const readerNotice = 'You can read this chat'
const openChatRoles = async (page: Page) => {
  await openSettings(page, 'Roles and Permissions')
  await mainOf(page).getByRole('tab', { name: 'Chat roles' }).click()
}
const workspaceRolesOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Workspace roles' })
const workspaceRoleItemOf = (page: Page, name: string) =>
  workspaceRolesOf(page).getByRole('list', { name: 'Workspace roles' }).getByRole('listitem', { name, exact: true })
const settingsLinkOf = (page: Page) => sidebarOf(page).getByRole('link', { name: 'Workspace settings' })
const memberRoleSelectOf = (page: Page, name: string) =>
  mainOf(page)
    .getByRole('region', { name: 'Members' })
    .getByRole('combobox', { name: `Role of ${name}` })
const rolesSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Chat roles' })
const roleItemOf = (page: Page, name: string) =>
  rolesSectionOf(page).getByRole('list', { name: 'Chat roles' }).getByRole('listitem', { name, exact: true })
const roleFormOf = (page: Page, label: string) => rolesSectionOf(page).getByRole('form', { name: label })
const deleteDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Delete role' })
const inviteRoleOptionsOf = async (page: Page) => {
  await tabPanelOf(page).getByRole('button', { name: 'Invite' }).click()
  return tabPanelOf(page)
    .getByRole('form', { name: 'Invite' })
    .getByLabel('Role')
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.textContent))
}
const insertRole = (workerStack: WorkerStack, id: string, name: string, permissions: string[]) =>
  workerStack.database.$client`
    insert into chat_roles (workspace_id, id, name, permissions, built_in)
    values ('workspace-acme', ${id}, ${name}, ${workerStack.database.$client.array(permissions)}, false)`
const fillRoleForm = async (page: Page, label: string, name: string, permissionLabels: string[]) => {
  const form = roleFormOf(page, label)
  await form.getByRole('textbox', { name: 'Name' }).fill(name)
  for (const permissionLabel of permissionLabels) await form.getByLabel(permissionLabel).check()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toHaveCount(0)
}
const createRole = async (page: Page, name: string, permissionLabels: string[]) => {
  await openChatRoles(page)
  await rolesSectionOf(page).getByRole('button', { name: 'New role' }).click()
  await expect(roleFormOf(page, 'New role').getByLabel('Read the chat')).toBeDisabled()
  await expect(roleFormOf(page, 'New role').getByLabel('Read the chat')).toBeChecked()
  await fillRoleForm(page, 'New role', name, permissionLabels)
  await expect(roleItemOf(page, name)).toBeVisible()
}
const editRole = async (page: Page, name: string, permissionLabels: string[]) => {
  await roleItemOf(page, name)
    .getByRole('button', { name: `Edit ${name}` })
    .click()
  await fillRoleForm(page, `Edit ${name}`, name, permissionLabels)
}
const deleteRole = async (page: Page, name: string) => {
  await roleItemOf(page, name)
    .getByRole('button', { name: `Delete ${name}` })
    .click()
  await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('Alice creates Reviewer with read and session configuration: it is listed in plain words, built-ins have no edit controls', {
  tag: ['@spec-47'],
}, async ({ page }) => {
  await createRole(page, 'Reviewer', ['Choose the model and stop the agent'])
  await expect(roleItemOf(page, 'Reviewer')).toContainText(
    /^Reviewer\s*Read the chat\s*Choose the model and stop the agent\s*Edit\s*Delete$/,
  )
  for (const builtInName of ['Owner', 'Editor', 'Prompter', 'Reader'])
    await expect(roleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await expect(mainOf(page).getByRole('link', { name: 'Roles and Permissions', exact: true })).toContainText(
    '6 built-in roles · 1 custom role',
  )
})

test('Alice makes Lee a Reviewer from the Members tab: his session window becomes editable while his composer stays blocked', {
  tag: ['@spec-47'],
}, async ({ page, browser, workerStack }) => {
  await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
  const chatId = await newRuntimeChat(page, 'Lee reviews')
  await addParticipant(workerStack, chatId, 'member-lee', 'reader')
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await addLlmKey(leePage, 'Fake')
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

test('Alice adds Post to Reviewer: Lee’s composer unblocks without a reload and his prompt is answered', {
  tag: ['@spec-47', '@smoke'],
}, async ({ page, browser, workerStack }) => {
  await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
  const chatId = await newRuntimeChat(page, 'Lee posts')
  await addParticipant(workerStack, chatId, 'member-lee', 'role-reviewer')
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await addLlmKey(leePage, 'Fake')
  await openChat(leePage, 'Lee posts')
  await expect(mainOf(leePage)).toContainText(readerNotice)

  await openChatRoles(page)
  await editRole(page, 'Reviewer', ['Post and prompt the agent'])
  await expect(roleItemOf(page, 'Reviewer')).toContainText('Post and prompt the agent')
  await expect(mainOf(leePage)).not.toContainText(readerNotice)
  await sendMessage(leePage, 'Lee asks now')
  await expect(messageContaining(leePage, agentReplyText)).toHaveCount(1)
  await leePage.context().close()
})

test('deleting Reviewer while Lee holds it is refused with the usage message; once Lee is a Reader again it is deleted', {
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

test('a public channel offers no Reviewer without post, and an Editor invites only with roles within his own permissions', {
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

test('creating, changing and deleting a role appear in the Audit log under Roles', { tag: ['@spec-47'] }, async ({
  page,
}) => {
  await createRole(page, 'Auditor', [])
  await editRole(page, 'Auditor', ['Invite people to the chat'])
  await deleteRole(page, 'Auditor')
  await expect(roleItemOf(page, 'Auditor')).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Audit log', exact: true }).click()
  const auditSection = mainOf(page).getByRole('region', { name: 'Audit log' })
  await auditSection
    .getByRole('group', { name: 'Filters' })
    .getByRole('combobox', { name: 'Type' })
    .selectOption('Roles')
  const records = auditSection.getByRole('list', { name: 'Audit records' }).getByRole('listitem')
  await expect(records).toHaveCount(3)
  await expect(records.nth(0)).toContainText(/Alice\s*Deleted a chat role\s*Auditor/)
  await expect(records.nth(1)).toContainText(/Alice\s*Changed a chat role\s*Auditor/)
  await expect(records.nth(2)).toContainText(/Alice\s*Created a chat role\s*Auditor/)
})

test('As an Admin, I create a Finance workspace role with costs and budgets and give it to Bob: he sees only Analyze costs, without a reload, and is refused the other settings pages', {
  tag: ['@spec-50', '@smoke'],
}, async ({ page, browser, workerStack }) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await expect(sidebarOf(bobPage).getByRole('link', { name: 'Profile' })).toBeVisible()
  await expect(settingsLinkOf(bobPage)).toHaveCount(0)

  await openSettings(page, 'Roles and Permissions')
  await workspaceRolesOf(page).getByRole('button', { name: 'New role' }).click()
  const form = workspaceRolesOf(page).getByRole('form', { name: 'New role' })
  await form.getByRole('textbox', { name: 'Name' }).fill('Finance')
  for (const permissionLabel of ['View costs', 'Manage budgets']) await form.getByLabel(permissionLabel).check()
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(workspaceRoleItemOf(page, 'Finance')).toContainText(
    /^Finance\s*View costs\s*Manage budgets\s*Edit\s*Delete$/,
  )
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Manage Team', exact: true }).click()
  await memberRoleSelectOf(page, 'Bob').selectOption({ label: 'Finance' })

  await settingsLinkOf(bobPage).click()
  await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible()
  const bobsCards = mainOf(bobPage).getByRole('region').getByRole('link')
  await expect(bobsCards).toHaveCount(1)
  await expect(bobsCards).toHaveAccessibleName('Analyze costs')
  await bobsCards.click()
  await expect(mainOf(bobPage).getByRole('region', { name: 'Budgets' })).toBeVisible()
  await expect(mainOf(bobPage).getByRole('region', { name: 'Usage' })).toBeVisible()
  for (const card of ['team', 'roles', 'audit', 'runtime']) {
    await bobPage.goto(`/w/workspace-acme/settings/${card}`)
    await expect(mainOf(bobPage)).toContainText('Your workspace role does not give access to this page')
  }
  await bobPage.context().close()
})

test('As an Admin, I cannot delete a workspace role Bob holds; once he is a Member again, it is deleted', {
  tag: ['@spec-50'],
}, async ({ page, workerStack }) => {
  await insertWorkspaceRole(workerStack, 'role-finance', 'Finance', ['costs.view'])
  await giveWorkspaceRole(workerStack, 'member-bob', 'role-finance')
  await openSettings(page, 'Roles and Permissions')
  await workspaceRoleItemOf(page, 'Finance').getByRole('button', { name: 'Delete Finance' }).click()
  await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
  await expect(deleteDialogOf(page)).toContainText('Finance is held by 1 member; change their role first')
  await deleteDialogOf(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(workspaceRoleItemOf(page, 'Finance')).toBeVisible()

  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Manage Team', exact: true }).click()
  await memberRoleSelectOf(page, 'Bob').selectOption({ label: 'Member' })
  await expect(memberRoleSelectOf(page, 'Bob')).toHaveValue('member')
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await mainOf(page).getByRole('link', { name: 'Roles and Permissions', exact: true }).click()
  await workspaceRoleItemOf(page, 'Finance').getByRole('button', { name: 'Delete Finance' }).click()
  await deleteDialogOf(page).getByRole('button', { name: 'Delete' }).click()
  await expect(workspaceRoleItemOf(page, 'Finance')).toHaveCount(0)
})

test('As an Admin, I see Workspace roles and Chat roles as two lists whose built-in roles are read-only', {
  tag: ['@spec-50'],
}, async ({ page }) => {
  await openSettings(page, 'Roles and Permissions')
  await expect(mainOf(page).getByRole('tab')).toHaveText(['Workspace roles', 'Chat roles'])
  await expect(
    workspaceRolesOf(page).getByRole('list', { name: 'Workspace roles' }).getByRole('listitem', { name: /.+/ }),
  ).toHaveCount(2)
  await expect(workspaceRoleItemOf(page, 'Admin')).toContainText(
    /^Admin\s*Invite members\s*Change roles and remove members\s*Manage roles\s*Set up SSO\s*Connect GitHub\s*Manage shared MCP tools\s*Manage runtime hosts and local sessions\s*View costs\s*Manage budgets\s*View the audit log$/,
  )
  await expect(workspaceRoleItemOf(page, 'Member')).toHaveText(/^Member\s*No permissions$/)
  for (const builtInName of ['Admin', 'Member'])
    await expect(workspaceRoleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)

  await mainOf(page).getByRole('tab', { name: 'Chat roles' }).click()
  await expect(workspaceRolesOf(page)).toHaveCount(0)
  for (const builtInName of ['Owner', 'Editor', 'Prompter', 'Reader'])
    await expect(roleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)
})
