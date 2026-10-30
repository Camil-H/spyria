import { configureGitHubApp, expect, mainOf, openSettings, type Page, test } from './fixtures'

const sectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Setup commands' })
const tabOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('tablist', { name: 'Setup commands' }).getByRole('tab', { name, exact: true })
const commandOf = (page: Page) => sectionOf(page).getByLabel('Setup command', { exact: true })

test.describe('Setup commands', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I give a repository its own setup command next to the runtime hosts, and the others a default one', {
    tag: ['@spec-57'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Connect runtime')
    const section = sectionOf(page)
    await expect(tabOf(page, 'Default setup command')).toHaveAttribute('aria-selected', 'true')
    await commandOf(page).fill('bun install')
    await tabOf(page, 'New repository setup command').click()
    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await expect(tabOf(page, 'acme/app')).toHaveAttribute('aria-selected', 'true')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Give acme/app a setup command, or delete it')).toBeVisible()
    await commandOf(page).fill('bun install && bun run db:migrate')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()

    await page.reload()
    await expect(commandOf(page)).toHaveValue('bun install')
    await tabOf(page, 'acme/app').click()
    await expect(commandOf(page)).toHaveValue('bun install && bun run db:migrate')

    await section.getByRole('button', { name: 'Delete the setup command of acme/app' }).click()
    await expect(tabOf(page, 'Default setup command')).toHaveAttribute('aria-selected', 'true')
    await commandOf(page).fill('')
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(commandOf(page)).toHaveValue('')
    await expect(tabOf(page, 'acme/app')).toHaveCount(0)
  })
})
