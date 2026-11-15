import { expect, mainOf, type Page, sidebarOf, test } from '../fixtures'

const cardsBySection = {
  Organization: ['Single sign-on', 'GitHub', 'Members and roles'],
  Agents: ['Runtimes', 'AI providers', 'Tools', 'Quality gates'],
  Usage: ['Costs', 'Audit log'],
}
const sectionShownBy: Record<string, string> = {
  'Single sign-on': 'Sign-in',
  GitHub: 'GitHub',
  'Members and roles': 'Members',
  Runtimes: 'Runtime hosts',
  Tools: 'Servers',
  'AI providers': 'AI providers',
  'Quality gates': 'Quality gates',
  Costs: 'Usage',
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
    await expect(cardOf(page, 'Single sign-on')).toContainText("Signs in with this deployment's Dex")
    await expect(cardOf(page, 'Members and roles')).toContainText('3 members')
    await expect(cardOf(page, 'Runtimes')).toContainText('1 runtime host')
    await expect(cardOf(page, 'Tools')).toContainText('6 servers')
    await expect(cardOf(page, 'AI providers')).toContainText('Every provider allowed')
    await expect(cardOf(page, 'Quality gates')).toContainText('Off')
    await expect(cardOf(page, 'Costs')).toContainText(/\$\d+\.\d\d this month/)

    for (const [index, cardTitle] of Object.values(cardsBySection).flat().entries()) {
      await cardOf(page, cardTitle).click()
      await expect(mainOf(page).getByRole('heading', { level: 1, name: cardTitle })).toBeVisible()
      await expect(mainOf(page).getByRole('region', { name: sectionShownBy[cardTitle] })).toBeVisible()
      if (index % 2 === 0) await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
      else await page.keyboard.press('Escape')
      await expect(settingsHeadingOf(page)).toBeVisible()
    }
  })

  test('As a member who can manage the workspace, I open a card page from its URL, see the default sign-in named on Single sign-on, and a new invite counted on the Members and roles card', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    await page.goto('/w/workspace-acme/settings/team')
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Members and roles' })).toBeVisible()

    await page.goto('/w/workspace-acme/settings/sso')
    await expect(mainOf(page).getByRole('region', { name: 'Sign-in' })).toContainText(
      "Sign-in uses this deployment's Dex",
    )
    await expect(mainOf(page).getByLabel('Issuer')).toHaveCount(0)

    await page.goto('/w/workspace-acme/settings/team')
    await mainOf(page).getByRole('button', { name: 'Invite member' }).click()
    const inviteForm = mainOf(page).getByRole('form', { name: 'Invite member' })
    await inviteForm.getByRole('textbox', { name: 'Email' }).fill('nina@example.com')
    await inviteForm.getByRole('button', { name: 'Invite' }).click()
    await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(cardOf(page, 'Members and roles')).toContainText('3 members · 1 pending invite')
  })

  test('As a member who can manage the workspace, I am told when a settings page cannot be read instead of seeing it load forever', {
    tag: ['@spec-42'],
  }, async ({ page }) => {
    await page.route(/\/api\/(github-settings|audit-log\/retention)$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, body: 'Service unavailable' })
        : route.continue(),
    )

    await page.goto('/w/workspace-acme/settings/github')
    const githubSection = mainOf(page).getByRole('region', { name: 'GitHub' })
    await expect(githubSection.getByRole('alert')).toHaveText('The server could not be reached (503)')
    await expect(githubSection).not.toContainText('Loading…')

    await page.goto('/w/workspace-acme/settings/audit')
    await expect(mainOf(page).getByRole('alert')).toHaveText('The request was refused with 503')
    await expect(mainOf(page).getByRole('form', { name: 'Retention' })).toHaveCount(0)
    await expect(mainOf(page)).not.toContainText('Loading…')
  })
})
