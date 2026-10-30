import { configureGitHubApp, expect, mainOf, openSettings, test } from './fixtures'

test.describe('Setup commands', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
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
