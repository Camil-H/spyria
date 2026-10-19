import { configureGitHubApp, connectionsOf, expect, inPopup, openMyConnections, test } from './fixtures'

test.describe('GitHub account', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I connect my GitHub account in my profile’s connections and it reads Connected with my GitHub login', {
    tag: ['@spec-39'],
  }, async ({ page }) => {
    await configureGitHubApp(page)
    await openMyConnections(page)
    const github = connectionsOf(page).getByRole('group', { name: 'GitHub account' })
    await expect(github).toContainText('Not connected')
    await inPopup(page, () => github.getByRole('button', { name: 'Connect GitHub account' }).click())
    await expect(github).toContainText('Connected (alice-martin)')
    await page.reload()
    await connectionsOf(page).getByRole('tab', { name: 'My connections' }).click()
    await expect(connectionsOf(page).getByRole('group', { name: 'GitHub account' })).toContainText(
      'Connected (alice-martin)',
    )
  })
})
