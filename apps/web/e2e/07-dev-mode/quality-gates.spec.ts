import { openPageAs } from '../stack'
import { configureGitHubApp, expect, mainOf, openSettings, type Page, test } from './fixtures'

const sectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Quality gates' })
const stepsOf = (page: Page) => sectionOf(page).getByRole('list', { name: 'Gates' }).locator(':scope > li')
const tabOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('tablist', { name: 'Repositories' }).getByRole('tab', { name })

test.describe('Quality gates settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I turn quality gates on and give a repository its own gates: a command before the default gates and the CI checks that count, which stay after a reload; a member who cannot connect GitHub is refused the page', {
    tag: ['@spec-57'],
  }, async ({ page, browser, workerStack }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Quality gates')
    const section = sectionOf(page)
    const loopSwitch = section.getByRole('switch', { name: 'Agents in dev chats go through quality gates' })
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(tabOf(page, 'Every other repository')).toHaveAttribute('aria-selected', 'true')
    await expect(stepsOf(page).nth(0)).toHaveAttribute('aria-label', 'Gate 1: Code review')
    await expect(stepsOf(page)).toHaveCount(3)

    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await section.getByRole('button', { name: 'Give it its own gates' }).click()
    await expect(tabOf(page, 'acme/app')).toHaveAttribute('aria-selected', 'true')
    await section.getByRole('button', { name: 'Command', exact: true }).click()
    const command = stepsOf(page).nth(1)
    await expect(command).toHaveAttribute('aria-label', 'Gate 2: Command')
    await command.getByLabel('Name').fill('Lint')
    await command.getByLabel('Command', { exact: true }).fill('bun run lint')
    await section.getByRole('button', { name: 'Move Lint up' }).click()
    await expect(stepsOf(page).nth(0)).toHaveAttribute('aria-label', 'Gate 1: Lint')
    const ci = stepsOf(page).nth(3)
    await expect(ci).toHaveAttribute('aria-label', 'Gate 4: CI')
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
    await leePage.goto('/w/workspace-acme/settings/quality-gates')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'Quality gates' })).toHaveCount(0)
    await leePage.context().close()

    await loopSwitch.click()
    await expect(loopSwitch).toHaveAttribute('aria-checked', 'false')
  })

  test('As an admin, I give a repository its own setup command next to the runtime hosts, and every other repository a default one', {
    tag: ['@spec-57'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Connect runtime')
    const section = mainOf(page).getByRole('region', { name: 'Setup commands' })
    await section.getByLabel('Setup command of every other repository').fill('bun install')
    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await section.getByRole('button', { name: 'Give it its own setup command' }).click()
    await section.getByLabel('Setup command of acme/app').fill('bun install && bun run db:migrate')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(section.getByLabel('Setup command of every other repository')).toHaveValue('bun install')
    await expect(section.getByLabel('Setup command of acme/app')).toHaveValue('bun install && bun run db:migrate')
    await expect(section.getByRole('combobox', { name: 'Repository' })).toHaveValue('')

    await section.getByLabel('Setup command of every other repository').fill('')
    await section.getByRole('listitem').filter({ hasText: 'acme/app' }).getByRole('button', { name: 'Remove' }).click()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await expect(section.getByLabel('Setup command of acme/app')).toHaveCount(0)
  })
})
