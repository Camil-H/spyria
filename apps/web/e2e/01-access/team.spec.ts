import { openPageAs, type WorkerStack } from '../stack'
import {
  agentReplyText,
  composerOf,
  expect,
  giveWorkspaceRole,
  hostsSectionOf,
  insertWorkspaceRole,
  invite,
  machineTest,
  mainOf,
  membersSectionOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openProfile,
  openSettings,
  type Page,
  panelTabOf,
  pendingInvitesOf,
  sendMessage,
  sidebarOf,
  signedOutScreenOf,
  signInThroughProvider,
  switcherOf,
  tabPanelOf,
  test,
} from './fixtures'

const frozenNotice = 'This chat is frozen: its owner left the workspace'
const bobsChatId = 'chat-bobs-runtime'
const streamReconnectWaitMilliseconds = 2500
const bobsChatName = "Bob's runtime"

const memberRowOf = (page: Page, name: string) =>
  membersSectionOf(page).getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: name })
const sectionOf = (page: Page, sectionName: string) => mainOf(page).getByRole('region', { name: sectionName })
const settingsLinkOf = (page: Page) => sidebarOf(page).getByRole('link', { name: 'Workspace settings' })

const removeMember = async (page: Page, name: string) => {
  await membersSectionOf(page)
    .getByRole('button', { name: `Remove ${name}` })
    .click()
  await page.getByRole('dialog', { name: 'Remove member' }).getByRole('button', { name: 'Remove' }).click()
  await expect(memberRowOf(page, name)).toHaveCount(0)
}

const insertBobsRuntimeChat = async (workerStack: WorkerStack) => {
  await workerStack.database.$client.begin(async (sql) => {
    await sql`
      insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, archived, created_at)
      values ('workspace-acme', ${bobsChatId}, 'runtime', 'private', 'user', 'member-bob', ${bobsChatName}, false, false, now())`
    await sql`
      insert into chat_participants (workspace_id, chat_id, user_id, role_id)
      values ('workspace-acme', ${bobsChatId}, 'member-bob', 'owner'), ('workspace-acme', ${bobsChatId}, 'member-alice', 'prompter')`
  })
}

test.describe('Team', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openSettings(page, 'Manage Team')
  })

  test('As a member who can invite, I invite a person by email: they sign in through the auth provider, land in Acme and are listed as a member', {
    tag: ['@spec-36', '@smoke'],
  }, async ({ page, browser, workerStack }) => {
    await invite(page, 'Nina@Example.com')
    await expect(pendingInvitesOf(page)).toHaveCount(1)
    await expect(pendingInvitesOf(page)).toContainText('nina@example.com')
    await expect(pendingInvitesOf(page)).toContainText('Member')
    await expect(pendingInvitesOf(page)).toContainText('Expires in 7 days')

    const ninaPage = await openPageAs(browser, workerStack, null)
    await signInThroughProvider(ninaPage, 'nina@example.com')
    await expect(switcherOf(ninaPage)).toContainText('Acme')
    await expect(ninaPage.getByText(/No workspace has invited/)).toHaveCount(0)

    await expect(pendingInvitesOf(page)).toHaveCount(0)
    await expect(memberRowOf(page, 'nina@example.com')).toContainText('nina')
    await ninaPage.context().close()
  })

  test('As a member who can invite, I revoke a pending invite and its email is told no workspace invited it', {
    tag: ['@spec-36'],
  }, async ({ page, browser, workerStack }) => {
    await invite(page, 'nina@example.com')
    await expect(pendingInvitesOf(page)).toHaveCount(1)
    await membersSectionOf(page).getByRole('button', { name: 'Revoke the invite of nina@example.com' }).click()
    await expect(pendingInvitesOf(page)).toHaveCount(0)

    const ninaPage = await openPageAs(browser, workerStack, null)
    await signInThroughProvider(ninaPage, 'nina@example.com')
    await expect(ninaPage.getByText('No workspace has invited nina@example.com')).toBeVisible()
    await expect(sidebarOf(ninaPage)).toHaveCount(0)
    await expect(ninaPage.getByText(/Acme|Globex/)).toHaveCount(0)
    await ninaPage.context().close()
  })

  test('As a member who manages members, I promote Bob to Admin and he sees Workspace settings without a reload; demoting him takes it away', {
    tag: ['@spec-36'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await expect(switcherOf(bobPage)).toContainText('Acme')
    await expect(settingsLinkOf(bobPage)).toHaveCount(0)

    await membersSectionOf(page).getByRole('combobox', { name: 'Role of Bob' }).selectOption('admin')
    await expect(settingsLinkOf(bobPage)).toBeVisible()
    await openSettings(bobPage, 'Manage Team')
    await expect(membersSectionOf(bobPage)).toBeVisible()
    await expect(memberRowOf(bobPage, 'Bob').getByRole('combobox')).toHaveCount(0)
    await expect(memberRowOf(bobPage, 'Alice').getByRole('combobox', { name: 'Role of Alice' })).toBeEnabled()

    await membersSectionOf(page).getByRole('combobox', { name: 'Role of Bob' }).selectOption('member')
    await expect(settingsLinkOf(bobPage)).toHaveCount(0)
    await expect(membersSectionOf(bobPage)).toHaveCount(0)
    await expect(mainOf(bobPage)).toContainText('Your workspace role does not give access to this page')
    await bobPage.context().close()
  })

  machineTest(
    'As a member who manages members, I remove Bob mid-reply: his page signs out of Acme, his machine is removed and his runtime chat stays frozen until I take it over',
    { tag: ['@spec-36', '@slow'] },
    async ({ page, browser, workerStack, agentScript, release, machine }) => {
      await machine({ owner: 'member-bob' })
      await insertBobsRuntimeChat(workerStack)
      await agentScript(bobsChatId, { hold: 'answer' })
      const bobPage = await openPageAs(browser, workerStack, 'member-bob')
      let bobStreamConnections = 0
      bobPage.on('websocket', (socket) => {
        if (socket.url().endsWith('/api/stream')) bobStreamConnections++
      })
      await openChat(bobPage, bobsChatName)
      await page.goto('/w/workspace-acme/settings/runtime')
      await expect(hostsSectionOf(page)).toContainText('1 member uses their machine')
      await openChat(page, bobsChatName)
      await sendMessage(page, 'Watch this')
      await expect(messageContaining(bobPage, 'Understood,')).toHaveCount(1)

      await openSettings(page, 'Manage Team')
      await removeMember(page, 'Bob')
      await expect(signedOutScreenOf(bobPage, 'Acme')).toBeVisible()
      await expect(messageItemsOf(bobPage)).toHaveCount(0)
      const streamConnectionsWhenSignedOut = bobStreamConnections
      await bobPage.waitForTimeout(streamReconnectWaitMilliseconds)
      expect(bobStreamConnections).toBe(streamConnectionsWhenSignedOut)
      await expect(signedOutScreenOf(bobPage, 'Acme')).toBeVisible()
      await release('answer')
      await expect
        .poll(
          async () =>
            (await workerStack.database.$client`select removed_at from runtime_hosts where owner_id = 'member-bob'`)[0]
              ?.removed_at,
        )
        .toBeTruthy()
      const machinesCounted = page.waitForResponse((response) => response.url().endsWith('/runtime-hosts/machines'))
      await page.goto('/w/workspace-acme/settings/runtime')
      await machinesCounted
      await expect(hostsSectionOf(page)).not.toContainText('uses their machine')

      await openChat(page, bobsChatName)
      await expect(mainOf(page)).toContainText(frozenNotice)
      await expect(composerOf(page)).toHaveCount(0)
      const transfer = mainOf(page).getByRole('form', { name: 'Transfer chat' })
      await expect(transfer.getByRole('combobox', { name: 'Transfer to' })).toHaveValue('member-alice')
      await agentScript(bobsChatId, { text: agentReplyText })
      await transfer.getByRole('button', { name: 'Transfer' }).click()
      await expect(mainOf(page)).not.toContainText(frozenNotice)
      await expect(mainOf(page)).toContainText('Agent acts as Alice')
      await sendMessage(page, 'Back after the transfer')
      await expect(messageContaining(page, 'Back after the transfer')).toHaveCount(1)
      await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
      await bobPage.context().close()
    },
  )

  test('As a member who can invite, I invite a removed member again and they sign in back in Acme', {
    tag: ['@spec-36'],
  }, async ({ page, browser, workerStack }) => {
    await removeMember(page, 'Bob')
    await invite(page, 'bob@example.com')
    await expect(pendingInvitesOf(page)).toContainText('bob@example.com')

    const bobPage = await openPageAs(browser, workerStack, null)
    await signInThroughProvider(bobPage, 'bob@example.com')
    await expect(switcherOf(bobPage)).toContainText('Acme')
    await expect(memberRowOf(page, 'Bob')).toContainText('bob@example.com')
    await expect(pendingInvitesOf(page)).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member who manages members, I cannot change my own role or remove myself, and I can on the other rows', {
    tag: ['@spec-36', '@spec-50'],
  }, async ({ page }) => {
    const aliceRow = memberRowOf(page, 'Alice')
    await expect(aliceRow).toContainText('Admin (you)')
    await expect(aliceRow.getByRole('combobox')).toHaveCount(0)
    await expect(aliceRow.getByRole('button')).toHaveCount(0)
    await expect(memberRowOf(page, 'Bob').getByRole('combobox', { name: 'Role of Bob' })).toBeEnabled()
    await expect(memberRowOf(page, 'Bob').getByRole('button', { name: 'Remove Bob' })).toBeEnabled()
  })

  const roleOptionsOf = (page: Page, name: string) =>
    memberRowOf(page, name)
      .getByRole('combobox', { name: `Role of ${name}` })
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.textContent))

  test('As a member who manages members, I give Lee a role within my own permissions only, and it applies to him at once', {
    tag: ['@spec-50'],
  }, async ({ page, browser, workerStack }) => {
    await insertWorkspaceRole(workerStack, 'role-manager', 'Manager', ['members.invite', 'members.manage'])
    await insertWorkspaceRole(workerStack, 'role-finance', 'Finance', ['costs.view'])
    await giveWorkspaceRole(workerStack, 'member-bob', 'role-manager')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await expect(sidebarOf(leePage).getByRole('link', { name: 'Profile' })).toBeVisible()
    await expect(settingsLinkOf(leePage)).toHaveCount(0)

    await openSettings(bobPage, 'Manage Team')
    expect(await roleOptionsOf(bobPage, 'Lee')).toEqual(['Member', 'Manager'])
    await expect(memberRowOf(bobPage, 'Alice')).toContainText('Admin')
    await expect(memberRowOf(bobPage, 'Alice').getByRole('combobox')).toHaveCount(0)
    await memberRowOf(bobPage, 'Lee').getByRole('combobox', { name: 'Role of Lee' }).selectOption({ label: 'Manager' })

    await expect(settingsLinkOf(leePage)).toBeVisible()
    await expect(memberRowOf(page, 'Lee').getByRole('combobox', { name: 'Role of Lee' })).toHaveValue('role-manager')
    await bobPage.context().close()
    await leePage.context().close()
  })

  test('As the last Admin, I cannot be demoted by anyone; once Lee is a second Admin, he demotes me', {
    tag: ['@spec-50'],
  }, async ({ page, browser, workerStack }) => {
    await insertWorkspaceRole(workerStack, 'role-manager', 'Manager', ['members.manage'])
    await giveWorkspaceRole(workerStack, 'member-bob', 'role-manager')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openSettings(bobPage, 'Manage Team')
    await expect(memberRowOf(bobPage, 'Alice')).toContainText('Admin')
    await expect(memberRowOf(bobPage, 'Alice').getByRole('combobox')).toHaveCount(0)
    await expect(memberRowOf(bobPage, 'Alice').getByRole('button')).toHaveCount(0)
    await expect(memberRowOf(page, 'Alice')).toContainText('Admin (you)')
    await expect(memberRowOf(page, 'Alice').getByRole('combobox')).toHaveCount(0)

    await memberRowOf(page, 'Lee').getByRole('combobox', { name: 'Role of Lee' }).selectOption({ label: 'Admin' })
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await openSettings(leePage, 'Manage Team')
    const alicesRole = memberRowOf(leePage, 'Alice').getByRole('combobox', { name: 'Role of Alice' })
    await alicesRole.selectOption({ label: 'Member' })
    await expect(alicesRole).toHaveValue('member')
    await expect(mainOf(page)).toContainText('Your workspace role does not give access to this page')
    await expect(settingsLinkOf(page)).toHaveCount(0)
    await page.goto('/w/workspace-acme/settings')
    await expect(mainOf(page)).toContainText('You have no workspace settings to manage')
    await bobPage.context().close()
    await leePage.context().close()
  })

  test.describe(() => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

    test('As a member, I change my display name and it shows everywhere', async ({ page }) => {
      await openProfile(page)
      await sectionOf(page, 'Display name').getByRole('textbox', { name: 'Display name' }).fill('Alice D.')
      await sectionOf(page, 'Display name').getByRole('button', { name: 'Save' }).click()
      await expect(sectionOf(page, 'Display name').getByText('Saved')).toBeVisible()

      await openChat(page, 'Welcome')
      await expect(messageItemsOf(page).nth(1)).toContainText('Alice D.')

      await openChat(page, 'Invoice bug')
      await expect(mainOf(page).getByText('Agent acts as')).toContainText('Alice D.')
      await panelTabOf(page, 'Usage').click()
      await expect(tabPanelOf(page).getByRole('row', { name: /Alice D\./ })).toBeVisible()
      await panelTabOf(page, 'Members').click()
      await expect(tabPanelOf(page).getByRole('listitem').filter({ hasText: 'Alice D.' })).toContainText('Owner')
    })
  })
})
