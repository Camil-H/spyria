import {
  agentReplyText,
  composerOf,
  expect,
  hostsSectionOf,
  machineTest,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  openSettings,
  type Page,
  sendMessage,
  sidebarOf,
  signedOutScreenOf,
  signInThroughDex,
  switcherOf,
  test,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const frozenNotice = 'This chat is frozen: its owner left the workspace'
const bobsChatId = 'chat-sams-runtime'
const streamReconnectWaitMilliseconds = 2500
const bobsChatName = "Bob's runtime"

const membersSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Members' })
const memberRowOf = (page: Page, name: string) =>
  membersSectionOf(page).getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: name })
const pendingInvitesOf = (page: Page) =>
  membersSectionOf(page).getByRole('list', { name: 'Pending invites' }).getByRole('listitem')
const settingsLinkOf = (page: Page) => sidebarOf(page).getByRole('link', { name: 'Workspace settings' })

const invite = async (page: Page, email: string) => {
  const form = membersSectionOf(page).getByRole('form', { name: 'Invite member' })
  await form.getByRole('textbox', { name: 'Email' }).fill(email)
  await form.getByRole('combobox', { name: 'Role' }).selectOption('member')
  await form.getByRole('button', { name: 'Invite' }).click()
}

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

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openSettings(page, 'Manage Team')
})

test('1. an invited email signs in through Dex, lands in Acme and is listed as a member', async ({
  page,
  browser,
  workerStack,
}) => {
  await invite(page, 'Nina@Example.com')
  await expect(pendingInvitesOf(page)).toHaveCount(1)
  await expect(pendingInvitesOf(page)).toContainText('nina@example.com')
  await expect(pendingInvitesOf(page)).toContainText('Member')
  await expect(pendingInvitesOf(page)).toContainText('Expires in 7 days')

  const ninaPage = await openPageAs(browser, workerStack, null)
  await signInThroughDex(ninaPage, 'nina@example.com')
  await expect(switcherOf(ninaPage)).toContainText('Acme')
  await expect(ninaPage.getByText(/No workspace has invited/)).toHaveCount(0)

  await expect(pendingInvitesOf(page)).toHaveCount(0)
  await expect(memberRowOf(page, 'nina@example.com')).toContainText('nina')
  await ninaPage.context().close()
})

test('2. a revoked invite no longer lets its email in', async ({ page, browser, workerStack }) => {
  await invite(page, 'nina@example.com')
  await expect(pendingInvitesOf(page)).toHaveCount(1)
  await membersSectionOf(page).getByRole('button', { name: 'Revoke the invite of nina@example.com' }).click()
  await expect(pendingInvitesOf(page)).toHaveCount(0)

  const ninaPage = await openPageAs(browser, workerStack, null)
  await signInThroughDex(ninaPage, 'nina@example.com')
  await expect(ninaPage.getByText('No workspace has invited nina@example.com')).toBeVisible()
  await ninaPage.context().close()
})

test('3. promoting Bob shows him Workspace settings without a reload, demoting him takes it away', async ({
  page,
  browser,
  workerStack,
}) => {
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
  await expect(mainOf(bobPage)).toContainText('Only workspace admins can see this page')
  await bobPage.context().close()
})

machineTest(
  '4. removing Bob mid-reply signs his page out of Acme, removes his machine and freezes his runtime chat until Alice takes it over',
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

test('5. a removed member invited again signs in and is back in Acme', async ({ page, browser, workerStack }) => {
  await removeMember(page, 'Bob')
  await invite(page, 'bob@example.com')
  await expect(pendingInvitesOf(page)).toContainText('bob@example.com')

  const bobPage = await openPageAs(browser, workerStack, null)
  await signInThroughDex(bobPage, 'bob@example.com')
  await expect(switcherOf(bobPage)).toContainText('Acme')
  await expect(memberRowOf(page, 'Bob')).toContainText('bob@example.com')
  await expect(pendingInvitesOf(page)).toHaveCount(0)
  await bobPage.context().close()
})

test('6. an admin sees their own row without a role select or Remove, and both on the other rows', async ({ page }) => {
  const aliceRow = memberRowOf(page, 'Alice')
  await expect(aliceRow).toContainText('Admin (you)')
  await expect(aliceRow.getByRole('combobox')).toHaveCount(0)
  await expect(aliceRow.getByRole('button')).toHaveCount(0)
  await expect(memberRowOf(page, 'Bob').getByRole('combobox', { name: 'Role of Bob' })).toBeEnabled()
  await expect(memberRowOf(page, 'Bob').getByRole('button', { name: 'Remove Bob' })).toBeEnabled()
})
