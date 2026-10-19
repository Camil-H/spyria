import { expect, mainOf, type Page, sidebarOf, test } from './fixtures'

const cardsBySection = {
  'Setup your organization': ['Setup SSO', 'Connect GitHub', 'Roles and Permissions', 'Manage Team'],
  'Setup your agents': ['Connect runtime', 'MCP tools'],
  'Analyze usage': ['Analyze costs', 'Audit log'],
}
const sectionShownBy: Record<string, string> = {
  'Setup SSO': 'Sign-in',
  'Connect GitHub': 'GitHub',
  'Roles and Permissions': 'Chat roles',
  'Manage Team': 'Members',
  'Connect runtime': 'Runtime hosts',
  'MCP tools': 'Connections',
  'Analyze costs': 'Usage',
  'Audit log': 'Audit log',
}
const cardOf = (page: Page, title: string) => mainOf(page).getByRole('link', { name: title, exact: true })
const settingsHeadingOf = (page: Page) => mainOf(page).getByRole('heading', { level: 1, name: 'Workspace settings' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await sidebarOf(page).getByRole('link', { name: 'Workspace settings' }).click()
  await expect(settingsHeadingOf(page)).toBeVisible()
})

test('Workspace settings list their cards in three sections with a status; each card opens its page and the back arrow returns', {
  tag: ['@spec-42'],
}, async ({ page }) => {
  for (const [sectionTitle, cardTitles] of Object.entries(cardsBySection)) {
    const section = mainOf(page).getByRole('region', { name: sectionTitle })
    await expect(section.getByRole('link')).toHaveCount(cardTitles.length)
    for (const cardTitle of cardTitles) await expect(section.getByRole('link', { name: cardTitle })).toBeVisible()
  }
  await expect(cardOf(page, 'Setup SSO')).toContainText("Signs in with this deployment's Dex")
  await expect(cardOf(page, 'Roles and Permissions')).toContainText('4 built-in roles')
  await expect(cardOf(page, 'Manage Team')).toContainText('3 members')
  await expect(cardOf(page, 'Connect runtime')).toContainText('1 runtime host')
  await expect(cardOf(page, 'MCP tools')).toContainText('1 shared connection')
  await expect(cardOf(page, 'Analyze costs')).toContainText(/\$\d+\.\d\d this month/)

  for (const cardTitle of Object.values(cardsBySection).flat()) {
    await cardOf(page, cardTitle).click()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: cardTitle })).toBeVisible()
    await expect(mainOf(page).getByRole('region', { name: sectionShownBy[cardTitle] })).toBeVisible()
    await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
    await expect(settingsHeadingOf(page)).toBeVisible()
  }
})

test('a card page opens from its URL; Roles and Permissions lists the built-in roles in plain words, Setup SSO names the Dex sign-in, and a new invite shows on the Manage Team card', {
  tag: ['@spec-42'],
}, async ({ page }) => {
  await page.goto('/w/workspace-acme/settings/roles')
  await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Roles and Permissions' })).toBeVisible()
  const roles = mainOf(page).getByRole('list', { name: 'Chat roles' }).getByRole('listitem', { name: /.+/ })
  await expect(roles).toHaveCount(4)
  await expect(mainOf(page).getByRole('listitem', { name: 'Reader' })).toHaveText(/^Reader\s*Read the chat$/)
  await expect(mainOf(page).getByRole('listitem', { name: 'Owner' })).toContainText('Change roles and remove people')

  await page.goto('/w/workspace-acme/settings/sso')
  await expect(mainOf(page).getByRole('region', { name: 'Sign-in' })).toContainText(
    "Sign-in uses this deployment's Dex",
  )
  await expect(mainOf(page).getByLabel('Issuer')).toHaveCount(0)

  await page.goto('/w/workspace-acme/settings/team')
  const inviteForm = mainOf(page).getByRole('form', { name: 'Invite member' })
  await inviteForm.getByRole('textbox', { name: 'Email' }).fill('nina@example.com')
  await inviteForm.getByRole('button', { name: 'Invite' }).click()
  await expect(mainOf(page).getByRole('list', { name: 'Pending invites' })).toContainText('nina@example.com')
  await mainOf(page).getByRole('link', { name: 'Back to Workspace settings' }).click()
  await expect(cardOf(page, 'Manage Team')).toContainText('3 members · 1 pending invite')
})
