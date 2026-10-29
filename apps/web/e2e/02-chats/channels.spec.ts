import { openPageAs } from '../stack'
import {
  answerNewChannel,
  chatAction,
  chatLinkOf,
  chipOf,
  composerOf,
  expect,
  expectMembers,
  mainOf,
  messageContaining,
  mutationGateOf,
  newChatAnswerOf,
  newChatDialogOf,
  type Page,
  panelTabOf,
  runsOnOf,
  sendMessage,
  sidebarOf,
  tabPanelOf,
  test,
} from './fixtures'

const newChannel = async (page: Page, name: string, visibility: 'Public' | 'Private') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  await answerNewChannel(newChatDialogOf(page), visibility === 'Public' ? 'public' : 'private')
  await newChatDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill(name)
  await newChatDialogOf(page).getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
}
const browseOf = (page: Page) => page.getByRole('dialog', { name: 'Browse public chats' })
const browsedChatOf = (page: Page, name: string) => browseOf(page).getByRole('listitem', { name })
const openBrowse = async (page: Page) => {
  await sidebarOf(page)
    .getByRole('button', { name: /^Browse public chats/ })
    .click()
  await expect(browseOf(page)).toBeVisible()
}
const closeBrowse = (page: Page) => browseOf(page).getByRole('button', { name: 'Close' }).click()
const joinFromBrowse = async (page: Page, name: string) => {
  await openBrowse(page)
  await browsedChatOf(page, name).getByRole('button', { name: 'Join' }).click()
  await expect(chatLinkOf(page, name)).toBeVisible()
  await expect(browsedChatOf(page, name)).toHaveCount(0)
  await closeBrowse(page)
}

test.describe('Channels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a channel owner, I create a private channel that reaches neither Bob’s sidebar nor his Browse until I invite him', {
    tag: ['@spec-30'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await newChannel(page, 'Backroom', 'Private')
    await openBrowse(bobPage)
    await expect(browsedChatOf(bobPage, 'Welcome')).toHaveCount(0)
    await expect(browseOf(bobPage)).toContainText('No chats to join')
    await closeBrowse(bobPage)
    await expect(chatLinkOf(bobPage, 'Backroom')).toHaveCount(0)
    await panelTabOf(page, 'Members').click()
    await tabPanelOf(page).getByRole('button', { name: 'Invite' }).click()
    const inviteForm = tabPanelOf(page).getByRole('form', { name: 'Invite' })
    await inviteForm.getByLabel('Member').selectOption({ label: 'Bob' })
    await inviteForm.getByRole('button', { name: 'Add to chat' }).click()
    await expect(chatLinkOf(bobPage, 'Backroom')).toBeVisible()
    await bobPage.context().close()
  })

  test('As a member, I read a public channel from Browse before joining, then join it as a Prompter', {
    tag: ['@spec-30'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await newChannel(page, 'Lounge', 'Public')
    await sendMessage(page, 'Welcome to the lounge')
    await expect(chatLinkOf(bobPage, 'Lounge')).toHaveCount(0)
    await openBrowse(bobPage)
    await expect(browsedChatOf(bobPage, 'Lounge')).toContainText('1 member')
    await browsedChatOf(bobPage, 'Lounge').getByRole('link').click()
    await expect(browseOf(bobPage)).toHaveCount(0)
    await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Lounge' })).toBeVisible()
    await expect(messageContaining(bobPage, 'Welcome to the lounge')).toHaveCount(1)
    await expect(composerOf(bobPage)).toHaveCount(0)
    await mainOf(bobPage).getByRole('button', { name: 'Join channel' }).click()
    await expect(chatLinkOf(bobPage, 'Lounge')).toBeVisible()
    await expect(composerOf(bobPage)).toBeVisible()
    await expect(mainOf(bobPage).getByRole('button', { name: 'Join channel' })).toHaveCount(0)
    await panelTabOf(bobPage, 'Members').click()
    await expectMembers(bobPage, [
      ['Alice', 'Owner'],
      ['Bob', 'Prompter'],
    ])
    await bobPage.context().close()
  })

  test('As a member, I leave a public channel from its menu: it leaves my sidebar and is listed in Browse again', {
    tag: ['@spec-30'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await newChannel(page, 'Coffee', 'Public')
    await joinFromBrowse(bobPage, 'Coffee')
    await chatAction(bobPage, 'Coffee', 'Leave channel')
    await expect(chatLinkOf(bobPage, 'Coffee')).toHaveCount(0)
    await openBrowse(bobPage)
    await expect(browsedChatOf(bobPage, 'Coffee')).toBeVisible()
    await bobPage.context().close()
  })

  test('As a channel owner, I make a public channel private: Lee no longer finds it in Browse, while Bob who joined keeps it', {
    tag: ['@spec-30'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await newChannel(page, 'Plans', 'Public')
    await joinFromBrowse(bobPage, 'Plans')
    await openBrowse(leePage)
    await expect(browsedChatOf(leePage, 'Plans')).toBeVisible()
    await chatAction(page, 'Plans', 'Make private')
    await expect(browsedChatOf(leePage, 'Plans')).toHaveCount(0)
    await expect(chatLinkOf(bobPage, 'Plans')).toBeVisible()
    await page.getByRole('button', { name: 'Chat actions for Plans' }).click()
    await expect(page.getByRole('menuitem', { name: 'Make public' })).toBeVisible()
    await page.keyboard.press('Escape')
    await bobPage.context().close()
    await leePage.context().close()
  })

  test('As a member, I see no agent bar in a channel, and I create a public AI chat that Bob reads from Browse and joins as a Prompter', {
    tag: ['@spec-30'],
  }, async ({ page, browser, workerStack }) => {
    await chatLinkOf(page, 'Welcome').click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
    await expect(composerOf(page)).toBeVisible()
    await expect(runsOnOf(page)).toHaveCount(0)
    await expect(chipOf(page, 'any')).toHaveCount(0)
    await page.getByRole('button', { name: 'New chat' }).click()
    const dialog = newChatDialogOf(page)
    await newChatAnswerOf(dialog, 'isPublic', 'Yes').check()
    await newChatAnswerOf(dialog, 'audience', 'AI chat').check()
    await newChatAnswerOf(dialog, 'github', 'Yes').check()
    await newChatAnswerOf(dialog, 'audience', 'Team channel').check()
    await newChatAnswerOf(dialog, 'audience', 'AI chat').check()
    await expect(
      dialog.getByRole('radiogroup', { name: 'Does it need GitHub access?' }).getByRole('radio', { checked: true }),
    ).toHaveCount(0)
    await newChatAnswerOf(dialog, 'github', 'No').check()
    await dialog.getByRole('textbox', { name: 'Chat name' }).fill('Forecasts')
    await dialog.getByRole('button', { name: 'Confirm' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Forecasts' })).toBeVisible()
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openBrowse(bobPage)
    await expect(browsedChatOf(bobPage, 'Forecasts')).toContainText('1 member')
    await browsedChatOf(bobPage, 'Forecasts').getByRole('link').click()
    await expect(mainOf(bobPage).getByRole('heading', { level: 1, name: 'Forecasts' })).toBeVisible()
    await expect(composerOf(bobPage)).toHaveCount(0)
    await mainOf(bobPage).getByRole('button', { name: 'Join chat' }).click()
    await expect(chatLinkOf(bobPage, 'Forecasts')).toBeVisible()
    await panelTabOf(bobPage, 'Members').click()
    await expectMembers(bobPage, [
      ['Alice', 'Owner'],
      ['Bob', 'Prompter'],
    ])
    await bobPage.context().close()
  })

  test('As a channel owner, I get no Reader role and no Remove in a public channel’s Members tab, both come back once it is private, and making it public again turns a Reader into a Prompter', {
    tag: ['@spec-35'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await newChannel(page, 'Open floor', 'Public')
    await joinFromBrowse(bobPage, 'Open floor')
    await panelTabOf(page, 'Members').click()
    const optionsOf = (select: ReturnType<typeof tabPanelOf>) =>
      select.locator('option').evaluateAll((options) => options.map((option) => option.textContent))
    const bobRole = tabPanelOf(page).getByLabel('Role of Bob')
    await expect(bobRole).toHaveValue('prompter')
    expect(await optionsOf(bobRole)).toEqual(['Editor', 'Prompter'])
    await expect(tabPanelOf(page).getByRole('button', { name: 'Remove Bob' })).toHaveCount(0)
    await tabPanelOf(page).getByRole('button', { name: 'Invite' }).click()
    expect(await optionsOf(tabPanelOf(page).getByRole('form', { name: 'Invite' }).getByLabel('Role'))).toEqual([
      'Editor',
      'Prompter',
    ])
    await tabPanelOf(page).getByRole('button', { name: 'Cancel' }).click()
    await chatAction(page, 'Open floor', 'Make private')
    await expect(tabPanelOf(page).getByRole('button', { name: 'Remove Bob' })).toBeVisible()
    expect(await optionsOf(bobRole)).toEqual(['Editor', 'Prompter', 'Reader'])
    await bobRole.selectOption('reader')
    await expect(bobRole).toHaveValue('reader')
    await chatAction(page, 'Open floor', 'Make public')
    await expect(bobRole).toHaveValue('prompter')
    expect(await optionsOf(bobRole)).toEqual(['Editor', 'Prompter'])
    await bobPage.context().close()
  })

  test('As a member, my join waits for the server with every Join disabled, and a join refused because the channel turned private shows its error', {
    tag: ['@spec-35'],
  }, async ({ page, browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const gate = await mutationGateOf(bobPage)
    await newChannel(page, 'Lounge', 'Public')
    await newChannel(page, 'Garden', 'Public')
    await openBrowse(bobPage)
    gate.hold()
    await browsedChatOf(bobPage, 'Lounge').getByRole('button', { name: 'Join' }).click()
    await expect(browsedChatOf(bobPage, 'Garden').getByRole('button', { name: 'Join' })).toBeDisabled()
    await chatAction(page, 'Lounge', 'Make private')
    await expect
      .poll(
        async () =>
          (await workerStack.database.$client`select visibility from chats where name = 'Lounge'`)[0]?.visibility,
      )
      .toBe('private')
    gate.release()
    await expect(browseOf(bobPage).getByRole('alert')).toHaveText('You need the chat.read permission on this chat')
    await expect(browsedChatOf(bobPage, 'Garden').getByRole('button', { name: 'Join' })).toBeEnabled()
    await expect(browsedChatOf(bobPage, 'Lounge')).toHaveCount(0)
    await expect(chatLinkOf(bobPage, 'Lounge')).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a member, I search the joinable chats in Browse by name and by project, with a message when none match', {
    tag: ['@spec-42'],
  }, async ({ page, browser, workerStack }) => {
    await newChannel(page, 'Lounge', 'Public')
    await page.getByRole('button', { name: 'New chat' }).click()
    await answerNewChannel(newChatDialogOf(page), 'public')
    await newChatDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill('Invoices')
    await newChatDialogOf(page).getByLabel('Project').selectOption({ label: 'Billing' })
    await newChatDialogOf(page).getByRole('button', { name: 'Confirm' }).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible()

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openBrowse(bobPage)
    const search = browseOf(bobPage).getByRole('searchbox', { name: 'Search chats' })
    await expect(browsedChatOf(bobPage, 'Lounge')).toBeVisible()
    await expect(browsedChatOf(bobPage, 'Invoices')).toBeVisible()
    await search.fill('LOU')
    await expect(browsedChatOf(bobPage, 'Lounge')).toBeVisible()
    await expect(browsedChatOf(bobPage, 'Invoices')).toHaveCount(0)
    await search.fill('billing')
    await expect(browsedChatOf(bobPage, 'Invoices')).toBeVisible()
    await expect(browsedChatOf(bobPage, 'Lounge')).toHaveCount(0)
    await search.fill('zzz')
    await expect(browseOf(bobPage).getByRole('listitem')).toHaveCount(0)
    await expect(browseOf(bobPage)).toContainText('No chats match “zzz”')
    await search.fill('')
    await expect(browsedChatOf(bobPage, 'Lounge')).toBeVisible()
    await bobPage.context().close()
  })
})
