import {
  chatAction,
  chatLinkOf,
  chipOf,
  composerOf,
  expect,
  expectMembers,
  mainOf,
  messageContaining,
  modeOf,
  type Page,
  panelTabOf,
  runsOnOf,
  sendMessage,
  sidebarOf,
  tabPanelOf,
  test,
} from './fixtures'
import { openPageAs } from './stack'

const newChatDialogOf = (page: Page) => page.getByRole('dialog', { name: 'New chat' })
const visibilityOf = (page: Page) => newChatDialogOf(page).getByRole('radiogroup', { name: 'Visibility' })
const newChannel = async (page: Page, name: string, visibility: 'Public' | 'Private') => {
  await page.getByRole('button', { name: 'New chat' }).click()
  await newChatDialogOf(page).getByRole('radio', { name: 'Channel' }).check()
  await visibilityOf(page).getByRole('radio', { name: visibility }).check()
  await newChatDialogOf(page).getByRole('textbox', { name: 'Chat name' }).fill(name)
  await newChatDialogOf(page).getByRole('button', { name: 'Confirm' }).click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name })).toBeVisible()
}
const browseOf = (page: Page) => page.getByRole('dialog', { name: 'Browse channels' })
const browsedChannelOf = (page: Page, name: string) => browseOf(page).getByRole('listitem', { name })
const openBrowse = async (page: Page) => {
  await sidebarOf(page)
    .getByRole('button', { name: /^Browse channels/ })
    .click()
  await expect(browseOf(page)).toBeVisible()
}
const closeBrowse = (page: Page) => browseOf(page).getByRole('button', { name: 'Close' }).click()
const joinFromBrowse = async (page: Page, name: string) => {
  await openBrowse(page)
  await browsedChannelOf(page, name).getByRole('button', { name: 'Join' }).click()
  await expect(chatLinkOf(page, name)).toBeVisible()
  await expect(browsedChannelOf(page, name)).toHaveCount(0)
  await closeBrowse(page)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('30-1. a private channel reaches neither Bob’s sidebar nor his Browse until Alice invites him', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await newChannel(page, 'Backroom', 'Private')
  await openBrowse(bobPage)
  await expect(browsedChannelOf(bobPage, 'Welcome')).toHaveCount(0)
  await expect(browseOf(bobPage)).toContainText('No channels to join')
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

test('30-2. Bob reads a public channel from Browse before joining, then joins it as Prompter', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await newChannel(page, 'Lounge', 'Public')
  await sendMessage(page, 'Welcome to the lounge')
  await expect(chatLinkOf(bobPage, 'Lounge')).toHaveCount(0)
  await openBrowse(bobPage)
  await expect(browsedChannelOf(bobPage, 'Lounge')).toContainText('1 member')
  await browsedChannelOf(bobPage, 'Lounge').getByRole('link').click()
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

test('30-3. Bob leaves a public channel from its menu: it leaves his sidebar and is listed in Browse again', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await newChannel(page, 'Coffee', 'Public')
  await joinFromBrowse(bobPage, 'Coffee')
  await chatAction(bobPage, 'Coffee', 'Leave channel')
  await expect(chatLinkOf(bobPage, 'Coffee')).toHaveCount(0)
  await openBrowse(bobPage)
  await expect(browsedChannelOf(bobPage, 'Coffee')).toBeVisible()
  await bobPage.context().close()
})

test('30-4. Alice makes a public channel private: Lee no longer finds it in Browse, Bob who joined keeps it', async ({
  page,
  browser,
  workerStack,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  const leePage = await openPageAs(browser, workerStack, 'member-lee')
  await newChannel(page, 'Plans', 'Public')
  await joinFromBrowse(bobPage, 'Plans')
  await openBrowse(leePage)
  await expect(browsedChannelOf(leePage, 'Plans')).toBeVisible()
  await chatAction(page, 'Plans', 'Make private')
  await expect(browsedChannelOf(leePage, 'Plans')).toHaveCount(0)
  await expect(chatLinkOf(bobPage, 'Plans')).toBeVisible()
  await page.getByRole('button', { name: 'Chat actions for Plans' }).click()
  await expect(page.getByRole('menuitem', { name: 'Make public' })).toBeVisible()
  await page.keyboard.press('Escape')
  await bobPage.context().close()
  await leePage.context().close()
})

test('30-5. a channel shows no agent bar, and only a channel offers Public or Private when created', async ({
  page,
}) => {
  await chatLinkOf(page, 'Welcome').click()
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(composerOf(page)).toBeVisible()
  await expect(runsOnOf(page)).toHaveCount(0)
  await expect(chipOf(page, 'any')).toHaveCount(0)
  await expect(modeOf(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(visibilityOf(page).getByRole('radio', { name: 'Public' })).toBeChecked()
  await expect(visibilityOf(page).getByRole('radio', { name: 'Private' })).not.toBeChecked()
  await newChatDialogOf(page).getByRole('radio', { name: 'Runtime' }).check()
  await expect(visibilityOf(page)).toHaveCount(0)
})

test('35-3. a public channel’s Members tab offers no Reader role and no Remove, both come back once it is private, and making it public again turns a Reader into a Prompter', async ({
  page,
  browser,
  workerStack,
}) => {
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
