import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chipOf,
  expect,
  expectMembers,
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
  tabPanelOf,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const readerNotice = 'You can read this chat'
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
  await openSettings(page, 'Roles and Permissions')
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

test('47-1. Alice creates Reviewer with read and session configuration: it is listed in plain words, built-ins have no edit controls', async ({
  page,
}) => {
  await createRole(page, 'Reviewer', ['Choose the model and stop the agent'])
  await expect(roleItemOf(page, 'Reviewer')).toContainText(
    /^Reviewer\s*Read the chat\s*Choose the model and stop the agent\s*Edit\s*Delete$/,
  )
  for (const builtInName of ['Owner', 'Editor', 'Prompter', 'Reader'])
    await expect(roleItemOf(page, builtInName).getByRole('button')).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to Workspace settings' }).click()
  await expect(mainOf(page).getByRole('link', { name: 'Roles and Permissions', exact: true })).toContainText(
    '4 built-in roles · 1 custom role',
  )
})

test('47-2. Alice makes Lee a Reviewer from the Members tab: his session window becomes editable while his composer stays blocked', async ({
  page,
  browser,
  workerStack,
}) => {
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

test('47-3. Alice adds Post to Reviewer: Lee’s composer unblocks without a reload and his prompt is answered', async ({
  page,
  browser,
  workerStack,
}) => {
  await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
  const chatId = await newRuntimeChat(page, 'Lee posts')
  await addParticipant(workerStack, chatId, 'member-lee', 'role-reviewer')
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await addLlmKey(leePage, 'Fake')
  await openChat(leePage, 'Lee posts')
  await expect(mainOf(leePage)).toContainText(readerNotice)

  await openSettings(page, 'Roles and Permissions')
  await editRole(page, 'Reviewer', ['Post and prompt the agent'])
  await expect(roleItemOf(page, 'Reviewer')).toContainText('Post and prompt the agent')
  await expect(mainOf(leePage)).not.toContainText(readerNotice)
  await sendMessage(leePage, 'Lee asks now')
  await expect(messageContaining(leePage, agentReplyText)).toHaveCount(1)
  await leePage.context().close()
})

test('47-4. deleting Reviewer while Lee holds it is refused with the usage message; once Lee is a Reader again it is deleted', async ({
  page,
  workerStack,
}) => {
  await insertRole(workerStack, 'role-reviewer', 'Reviewer', ['chat.read', 'session.configure'])
  const chatId = await newRuntimeChat(page, 'Lee holds a role')
  await addParticipant(workerStack, chatId, 'member-lee', 'role-reviewer')
  await openSettings(page, 'Roles and Permissions')
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
  await openSettings(page, 'Roles and Permissions')
  await deleteRole(page, 'Reviewer')
  await expect(roleItemOf(page, 'Reviewer')).toHaveCount(0)
})

test('47-5. a public channel offers no Reviewer without post, and an Editor invites only with roles within his own permissions', async ({
  page,
  browser,
  workerStack,
}) => {
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

test('47-6. creating, changing and deleting a role appear in the Audit log under Roles', async ({ page }) => {
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
