import { expect, mainOf, type Page, sidebarOf, test } from '../fixtures'

const cardsBySection = {
  'Setup your organization': ['Setup SSO', 'Connect GitHub', 'Roles and Permissions', 'Manage Team'],
  'Setup your agents': ['Connect runtime', 'AI providers', 'MCP tools'],
  'Analyze usage': ['Analyze costs', 'Audit log'],
}
const sectionShownBy: Record<string, string> = {
  'Setup SSO': 'Sign-in',
  'Connect GitHub': 'GitHub',
  'Roles and Permissions': 'Workspace roles',
  'Manage Team': 'Members',
  'Connect runtime': 'Runtime hosts',
  'MCP tools': 'Connections',
  'AI providers': 'AI providers',
  'Analyze costs': 'Usage',
  'Audit log': 'Audit log',
}
const cardOf = (page: Page, title: string) => mainOf(page).getByRole('link', { name: title, exact: true })
const settingsHeadingOf = (page: Page) => mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
    await expect(settingsHeadingOf(page)).toBeVisible()
  })

  test('As a member who can manage the workspace, I see the settings cards in three sections with their status, each opening its page that the back arrow or Escape leaves', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    for (const [sectionTitle, cardTitles] of Object.entries(cardsBySection)) {
      const section = mainOf(page).getByRole('region', { name: sectionTitle })
      await expect(section.getByRole('link')).toHaveCount(cardTitles.length)
      for (const cardTitle of cardTitles) await expect(section.getByRole('link', { name: cardTitle })).toBeVisible()
    }
    await expect(cardOf(page, 'Setup SSO')).toContainText("Signs in with this deployment's Dex")
    await expect(cardOf(page, 'Roles and Permissions')).toContainText('6 built-in roles')
    await expect(cardOf(page, 'Manage Team')).toContainText('3 members')
    await expect(cardOf(page, 'Connect runtime')).toContainText('1 runtime host')
    await expect(cardOf(page, 'MCP tools')).toContainText('1 shared connection')
    await expect(cardOf(page, 'AI providers')).toContainText('Every provider allowed')
    await expect(cardOf(page, 'Analyze costs')).toContainText(/\$\d+\.\d\d this month/)

    for (const [index, cardTitle] of Object.values(cardsBySection).flat().entries()) {
      await cardOf(page, cardTitle).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: cardTitle })).toBeVisible()
      await expect(mainOf(page).getByRole('region', { name: sectionShownBy[cardTitle] })).toBeVisible()
      if (index % 2 === 0) await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
      else await page.keyboard.press('Escape')
      await expect(settingsHeadingOf(page)).toBeVisible()
    }
  })

  test('As a member who can manage the workspace, I open a card page from its URL, see the default sign-in named on Setup SSO, and a new invite counted on the Manage Team card', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    await page.goto('/w/workspace-acme/settings/roles')
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Roles and Permissions' })).toBeVisible()

    await page.goto('/w/workspace-acme/settings/sso')
    await expect(mainOf(page).getByRole('region', { name: 'Sign-in' })).toContainText(
      "Sign-in uses this deployment's Dex",
    )
    await expect(mainOf(page).getByLabel('Issuer')).toHaveCount(0)

    await page.goto('/w/workspace-acme/settings/team')
    const inviteForm = mainOf(page).getByRole('form', { name: 'Invite member' })
    await inviteForm.getByRole('textbox', { name: 'Email' }).fill('nina@example.com')
    await inviteForm.getByRole('button', { name: 'Invite' }).click()
    await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(cardOf(page, 'Manage Team')).toContainText('3 members · 1 pending invite')
  })
})
