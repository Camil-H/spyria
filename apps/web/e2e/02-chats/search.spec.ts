import { openPageAs } from '../stack'
import { alicesWelcomeMessage, composerOf, expect, mainOf, openChat, type Page, sidebarOf, test } from './fixtures'

const searchDialogOf = (page: Page) => page.getByRole('dialog', { name: 'Search messages' })
const searchResultsOf = (page: Page) => searchDialogOf(page).getByRole('list', { name: 'Search results' })
const findBoxOf = (page: Page) => mainOf(page).getByRole('searchbox', { name: 'Find in this chat' })
const findCountOf = (page: Page) => mainOf(page).getByRole('search', { name: 'Find in this chat' }).locator('output')
const highlightedMatches = (page: Page) =>
  page.evaluate(() => [...(CSS.highlights.get('find-match') ?? [])].map((range) => (range as Range).toString()))
const searchFor = async (page: Page, text: string) => {
  await expect(sidebarOf(page).getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await page.keyboard.press('/')
  await expect(searchDialogOf(page).getByRole('searchbox', { name: 'Search messages' })).toBeFocused()
  await page.keyboard.type(text)
}

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I search the messages of the chats I can read and open a match highlighted in its chat', {
    tag: ['@spec-52', '@smoke'],
  }, async ({ page }) => {
    await test.step('asks for a second character only once a first one is typed', async () => {
      await searchFor(page, '')
      await expect(searchDialogOf(page)).not.toContainText('Type at least')
      await page.keyboard.type('g')
      await expect(searchDialogOf(page)).toContainText('Type at least 2 characters')
      await page.keyboard.press('Escape')
      await expect(searchDialogOf(page)).toHaveCount(0)
    })

    await test.step('lists the matching messages with their chat and the match marked', async () => {
      await searchFor(page, 'GLAD to')
      const result = searchResultsOf(page).getByRole('button', { name: /Welcome/ })
      await expect(result).toContainText('Alice')
      await expect(result.locator('mark')).toHaveText('glad to')
    })

    await test.step('opens the chat with the match found and highlighted', async () => {
      await page.keyboard.press('Enter')
      await expect(searchDialogOf(page)).toHaveCount(0)
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
      await expect(findBoxOf(page)).toHaveValue('glad to')
      await expect(findCountOf(page)).toHaveText('1 of 1')
      await expect.poll(() => highlightedMatches(page)).toEqual(['glad to'])
    })

    await test.step('says when nothing matches', async () => {
      await findBoxOf(page).press('Escape')
      await searchFor(page, 'no such words anywhere')
      await expect(searchDialogOf(page)).toContainText('No messages match “no such words anywhere”')
    })
  })

  test('As a reader, I find the messages of a chat I read but none from a private chat I am not in', {
    tag: ['@spec-52'],
  }, async ({ browser, workerStack }) => {
    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await searchFor(leePage, 'tax is applied')
    await expect(searchResultsOf(leePage).getByRole('button', { name: /Invoice bug/ })).toBeVisible()
    await searchDialogOf(leePage).getByRole('searchbox', { name: 'Search messages' }).fill('dev environment')
    await expect(searchDialogOf(leePage)).toContainText('No messages match “dev environment”')
    await leePage.context().close()
  })

  test('As a member, I find text in a chat and step through its matches from the newest', {
    tag: ['@spec-52'],
  }, async ({ page }) => {
    await openChat(page, 'Welcome')
    await expect(composerOf(page)).toBeFocused()
    await mainOf(page).getByRole('button', { name: 'Find in this chat' }).click()
    await expect(findBoxOf(page)).toBeFocused()
    await findBoxOf(page).fill(' TO ')
    await expect(findCountOf(page)).toHaveText('2 of 2')
    await expect.poll(() => highlightedMatches(page)).toEqual(['to', 'to'])
    await findBoxOf(page).press('Enter')
    await expect(findCountOf(page)).toHaveText('1 of 2')
    await findBoxOf(page).press('Shift+Enter')
    await expect(findCountOf(page)).toHaveText('2 of 2')
    await mainOf(page).getByRole('button', { name: 'Previous match' }).click()
    await expect(findCountOf(page)).toHaveText('1 of 2')
    await findBoxOf(page).fill('nowhere')
    await expect(findCountOf(page)).toHaveText('No matches')
    await expect(mainOf(page).getByRole('button', { name: 'Next match' })).toBeDisabled()
    await findBoxOf(page).press('Escape')
    await expect(findBoxOf(page)).toHaveCount(0)
    await expect.poll(() => highlightedMatches(page)).toEqual([])
    await expect(mainOf(page)).toContainText(alicesWelcomeMessage)
  })
})
