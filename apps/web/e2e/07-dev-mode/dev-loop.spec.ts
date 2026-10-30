import { openPageAs } from '../stack'
import { configureGitHubApp, expect, mainOf, openSettings, type Page, test } from './fixtures'

const sectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Dev loop' })
const stepsOf = (page: Page) => sectionOf(page).getByRole('list', { name: 'Steps' }).locator(':scope > li')
const tabOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name })

test.describe('Dev loop settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I turn the dev loop on and give a repository its own pipeline: a command before the default steps and the CI checks that count, which stay after a reload; a member who cannot connect GitHub is refused the page', {
    tag: ['@spec-57'],
  }, async ({ page, browser, workerStack }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Dev loop')
    const section = sectionOf(page)
    const loopSwitch = section.getByRole('switch', { name: 'Agents in dev chats check their own work' })
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(tabOf(page, 'Every other repository')).toHaveAttribute('aria-selected', 'true')
    await expect(stepsOf(page).nth(0)).toHaveAttribute('aria-label', 'Step 1: Code review')
    await expect(stepsOf(page)).toHaveCount(3)

    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await section.getByRole('button', { name: 'Add pipeline' }).click()
    await expect(tabOf(page, 'acme/app')).toHaveAttribute('aria-selected', 'true')
    await section.getByRole('button', { name: 'Command', exact: true }).click()
    const command = stepsOf(page).nth(1)
    await expect(command).toHaveAttribute('aria-label', 'Step 2: Command')
    await command.getByLabel('Name').fill('Lint')
    await command.getByLabel('Command', { exact: true }).fill('bun run lint')
    await section.getByRole('button', { name: 'Move Lint up' }).click()
    await expect(stepsOf(page).nth(0)).toHaveAttribute('aria-label', 'Step 1: Lint')
    const ci = stepsOf(page).nth(3)
    await expect(ci).toHaveAttribute('aria-label', 'Step 4: CI')
    await ci.getByLabel('Check that counts').fill('ci-ok')
    await ci.getByRole('button', { name: 'Count it' }).click()
    await expect(ci.getByRole('list', { name: 'Checks that count' })).toHaveText('ci-ok')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()

    await page.reload()
    await tabOf(page, 'acme/app').click()
    await expect(stepsOf(page)).toHaveCount(4)
    await expect(stepsOf(page).nth(0).getByLabel('Command', { exact: true })).toHaveValue('bun run lint')
    await expect(stepsOf(page).nth(3).getByRole('list', { name: 'Checks that count' })).toHaveText('ci-ok')
    await tabOf(page, 'Every other repository').click()
    await expect(stepsOf(page)).toHaveCount(3)

    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await leePage.goto('/w/workspace-acme/settings/dev-loop')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'Dev loop' })).toHaveCount(0)
    await leePage.context().close()

    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
  })
})
