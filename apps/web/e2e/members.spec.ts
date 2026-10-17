import {
  addLlmKey,
  addParticipant,
  agentReplyText,
  chatLinkOf,
  expect,
  expectMembers,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openPanelTab,
  type Page,
  panelTabOf,
  sendButtonOf,
  sendMessage,
  tabPanelOf,
  test,
} from './fixtures'
import { openPageAs } from './stack'

const readerNotice = 'You can read this chat'
const inviteFormOf = (page: Page) => tabPanelOf(page).getByRole('form', { name: 'Invite' })
const optionsOf = (page: Page, label: string) =>
  inviteFormOf(page)
    .getByLabel(label)
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.textContent))
const invite = async (page: Page, memberName: string, roleName: string) => {
  await tabPanelOf(page).getByRole('button', { name: 'Invite' }).click()
  await inviteFormOf(page).getByLabel('Member').selectOption({ label: memberName })
  await inviteFormOf(page).getByLabel('Role').selectOption({ label: roleName })
  await inviteFormOf(page).getByRole('button', { name: 'Add to chat' }).click()
  await expect(inviteFormOf(page)).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('29-1. Alice invites Bob as Reader from the Members tab: the chat reaches Bob live and his composer is blocked', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await newRuntimeChat(page, 'Bob is invited')
  await panelTabOf(page, 'Members').click()
  await invite(page, 'Bob', 'Reader')
  await expectMembers(page, [
    ['Alice', 'Owner'],
    ['Bob', 'Reader'],
  ])
  await openChat(bobPage, 'Bob is invited')
  await expect(mainOf(bobPage)).toContainText(readerNotice)
  await expect(sendButtonOf(bobPage)).toBeDisabled()
  await bobPage.context().close()
})

test('29-2. Alice makes Bob a Prompter: Bob’s composer unblocks without a reload and his prompt is answered on his key', async ({
  page,
  browser,
  workerStack,
}) => {
  const chatId = await newRuntimeChat(page, 'Bob is promoted')
  await addParticipant(workerStack, chatId, 'member-bob', 'reader')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Bob is promoted')
  await expect(mainOf(bobPage)).toContainText(readerNotice)

  await panelTabOf(page, 'Members').click()
  await tabPanelOf(page).getByLabel('Role of Bob').selectOption({ label: 'Prompter' })
  await expect(mainOf(bobPage)).not.toContainText(readerNotice)
  await sendMessage(bobPage, 'Bob asks now')
  await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
  await expect
    .poll(async () =>
      (await workerStack.database.$client`select prompter_id from model_calls where chat_id = ${chatId}`).map(
        ({ prompter_id }) => prompter_id,
      ),
    )
    .toContain('member-bob')
  await bobPage.context().close()
})

test('29-3. Alice removes Bob while Bob watches a held reply: the chat leaves Bob’s sidebar and his page falls back', async ({
  page,
  browser,
  workerStack,
  agentScript,
  release,
}) => {
  const chatId = await newRuntimeChat(page, 'Bob is removed')
  await addParticipant(workerStack, chatId, 'member-bob', 'reader')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openChat(bobPage, 'Bob is removed')
  await agentScript(chatId, { hold: 'answer' })
  await sendMessage(page, 'Stream while Bob watches')
  await expect(messageItemsOf(bobPage).nth(1)).toContainText('Understood,')

  await panelTabOf(page, 'Members').click()
  await tabPanelOf(page).getByRole('button', { name: 'Remove Bob' }).click()
  await expectMembers(page, [['Alice', 'Owner']])
  await expect(chatLinkOf(bobPage, 'Bob is removed')).toHaveCount(0)
  await expect(mainOf(bobPage)).toContainText('Select a chat')
  await release('answer')
  await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  await expect(bobPage.getByText(agentReplyText)).toHaveCount(0)
  await bobPage.context().close()
})

test('29-4. an Editor invites with Editor, Prompter or Reader, never Owner, and gets no role select or Remove', async ({
  page,
  browser,
  workerStack,
}) => {
  const chatId = await newRuntimeChat(page, 'Bob edits')
  await addParticipant(workerStack, chatId, 'member-bob', 'editor')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openPanelTab(bobPage, 'Bob edits', 'Members')
  await expectMembers(bobPage, [
    ['Alice', 'Owner'],
    ['Bob', 'Editor'],
  ])
  await expect(tabPanelOf(bobPage).getByRole('combobox')).toHaveCount(0)
  await expect(tabPanelOf(bobPage).getByRole('button', { name: /^Remove/ })).toHaveCount(0)

  await tabPanelOf(bobPage).getByRole('button', { name: 'Invite' }).click()
  expect(await optionsOf(bobPage, 'Role')).toEqual(['Editor', 'Prompter', 'Reader'])
  expect(await optionsOf(bobPage, 'Member')).toEqual(['Lee'])
  await inviteFormOf(bobPage).getByRole('button', { name: 'Cancel' }).click()
  await invite(bobPage, 'Lee', 'Editor')
  await expectMembers(bobPage, [
    ['Alice', 'Owner'],
    ['Lee', 'Editor'],
    ['Bob', 'Editor'],
  ])
  await bobPage.context().close()
})

test('29-5. Bob leaves a chat he was invited to, and the owner has no Leave, role select or Remove on his own row', async ({
  page,
  browser,
  workerStack,
}) => {
  const chatId = await newRuntimeChat(page, 'Bob leaves')
  await addParticipant(workerStack, chatId, 'member-bob', 'prompter')
  await panelTabOf(page, 'Members').click()
  const aliceRow = tabPanelOf(page).getByRole('listitem').filter({ hasText: 'Alice' })
  await expect(aliceRow).toContainText('Owner')
  await expect(aliceRow.getByRole('combobox')).toHaveCount(0)
  await expect(aliceRow.getByRole('button')).toHaveCount(0)
  await expect(tabPanelOf(page).getByRole('button', { name: 'Leave chat' })).toHaveCount(0)

  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await openPanelTab(bobPage, 'Bob leaves', 'Members')
  await tabPanelOf(bobPage).getByRole('button', { name: 'Leave chat' }).click()
  await expect(chatLinkOf(bobPage, 'Bob leaves')).toHaveCount(0)
  await expect(mainOf(bobPage)).toContainText('Select a chat')
  await expectMembers(page, [['Alice', 'Owner']])
  await bobPage.context().close()
})
