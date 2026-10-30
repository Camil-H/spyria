import { openPageAs } from '../stack'
import { configureGitHubApp, expect, mainOf, openSettings, type Page, test } from './fixtures'

const sectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Quality gates' })
const gatesOf = (page: Page) => sectionOf(page).getByRole('list', { name: 'Gates' }).locator(':scope > li')
const tabOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('tablist', { name: 'Rules' }).getByRole('tab', { name, exact: true })
const switchOf = (page: Page) =>
  sectionOf(page).getByRole('switch', { name: 'Agents in dev chats go through these gates' })

test.describe('Quality gates settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I turn the default rules on, add rules for a repository with a command before the default gates, its own switch and limits, which stay after a reload; a member who cannot connect GitHub is refused the page', {
    tag: ['@spec-57'],
  }, async ({ page, browser, workerStack }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Quality gates')
    const section = sectionOf(page)
    await expect(tabOf(page, 'Default rules')).toHaveAttribute('aria-selected', 'true')
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(gatesOf(page)).toHaveCount(3)
    await expect(gatesOf(page).nth(2)).toHaveAttribute('aria-label', 'Gate 3: CI')
    await switchOf(page).click()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')

    await tabOf(page, 'New repository rules').click()
    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await expect(tabOf(page, 'acme/app')).toHaveAttribute('aria-selected', 'true')
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')
    await section.getByRole('button', { name: 'Command', exact: true }).click()
    const command = gatesOf(page).nth(1)
    await expect(command).toHaveAttribute('aria-label', 'Gate 2: Command')
    await command.getByLabel('Name').fill('Lint')
    await command.getByLabel('Command', { exact: true }).fill('bun run lint')
    await section.getByRole('button', { name: 'Move Lint up' }).click()
    await expect(gatesOf(page).nth(0)).toHaveAttribute('aria-label', 'Gate 1: Lint')
    await section.getByLabel('Time limit (minutes)').fill('60')
    await switchOf(page).click()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()

    await page.reload()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')
    await expect(gatesOf(page)).toHaveCount(3)
    await tabOf(page, 'acme/app').click()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(gatesOf(page)).toHaveCount(4)
    await expect(gatesOf(page).nth(0).getByLabel('Command', { exact: true })).toHaveValue('bun run lint')
    await expect(section.getByLabel('Time limit (minutes)')).toHaveValue('60')

    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await leePage.goto('/w/workspace-acme/settings/quality-gates')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'Quality gates' })).toHaveCount(0)
    await leePage.context().close()

    await section.getByRole('button', { name: 'Delete the rules of acme/app' }).click()
    await expect(tabOf(page, 'Default rules')).toHaveAttribute('aria-selected', 'true')
    await switchOf(page).click()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(tabOf(page, 'acme/app')).toHaveCount(0)
  })
})
