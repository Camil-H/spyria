import { openPageAs } from '../stack'
import { expect, mainOf, type Page, sidebarOf, test } from './fixtures'

const startLinkOf = (page: Page) => sidebarOf(page).getByRole('link', { name: /^Get started/ })
const checklistOf = (page: Page, title: string) => mainOf(page).getByRole('region', { name: new RegExp(`^${title}`) })
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('Onboarding', () => {
  test.use({ runtimeHost: false, warmRuntimes: false })

  test('As an admin, I see what is left to set up at the top of Workspace settings, follow a task to its page, and skipping the rest makes the checklist go away', {
    tag: ['@spec-54'],
  }, async ({ page }) => {
    await page.goto('/')
    await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
    const checklist = checklistOf(page, 'Get your workspace ready')

    await test.step('lists the workspace tasks I can do, in order, with what each is for', async () => {
      await expect(checklist).toContainText('1 of 3 done')
      await expect(checklist.getByRole('listitem')).toHaveText([
        /^To do: Connect the GitHub App.*open pull requests from dev chats/,
        /^To do: Connect a runtime.*isolated containers/,
        /^Done: Invite members/,
      ])
    })

    await test.step('opens the page of a task, and keeps the list collapsed once I collapse it', async () => {
      await checklist.getByRole('link', { name: 'Connect a runtime' }).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Connect runtime' })).toBeVisible()
      await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
      await checklist.getByRole('button', { name: /^Get your workspace ready/ }).click()
      await expect(checklist.getByRole('listitem')).toHaveCount(0)
      await page.reload()
      await expect(checklist).toContainText('1 of 3 done')
      await expect(checklist.getByRole('listitem')).toHaveCount(0)
      await checklist.getByRole('button', { name: /^Get your workspace ready/ }).click()
    })

    await test.step('a skipped task leaves the list and the count, and skipping all that is left removes the checklist', async () => {
      await checklist.getByRole('button', { name: 'Skip Connect the GitHub App' }).click()
      await expect(checklist.getByRole('listitem')).toHaveText([/^To do: Connect a runtime/, /^Done: Invite members/])
      await expect(checklist).toContainText('1 of 2 done')
      await checklist.getByRole('button', { name: 'Skip Connect a runtime' }).click()
      await expect(checklist).toHaveCount(0)
      await expect(startLinkOf(page)).toHaveAccessibleDescription('Next: Add a profile picture')
    })
  })

  test('As a member, I follow the checklist from the sidebar to my profile, skip adding an AI key, and once my picture is added the checklist goes away', {
    tag: ['@spec-54'],
  }, async ({ browser, workerStack }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    const startLink = startLinkOf(bobPage)
    await expect(startLink).toHaveAccessibleName('Get started: 0 of 2 done')
    await expect(startLink).toHaveAccessibleDescription('Next: Add your AI key')
    await expect(sidebarOf(bobPage).getByRole('link', { name: 'Workspace settings' })).toHaveCount(0)

    await startLink.click()
    const checklist = checklistOf(bobPage, 'Set up your profile')
    await expect(checklist).toContainText("Spyria doesn't sell AI usage")
    await checklist.getByRole('button', { name: 'Skip Add your AI key' }).click()
    await expect(checklist.getByRole('listitem')).toHaveText([/^To do: Add a profile picture/])
    await expect(startLink).toHaveAccessibleName('Get started: 0 of 1 done')
    await expect(startLink).toHaveAccessibleDescription('Next: Add a profile picture')

    const fileChooser = bobPage.waitForEvent('filechooser')
    await mainOf(bobPage)
      .getByRole('region', { name: 'Profile picture' })
      .getByRole('button', { name: 'Add profile picture' })
      .click()
    await (await fileChooser).setFiles({ name: 'me.png', mimeType: 'image/png', buffer: onePixelPng })
    await expect(checklist).toHaveCount(0)
    await expect(startLink).toHaveCount(0)
    await bobPage.context().close()
  })
})
