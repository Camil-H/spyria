import { projects } from '@hq/db/postgres'
import type { Page } from '@playwright/test'
import { expect, test } from './stack.ts'

const sidebarOf = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const projectGroupOf = (page: Page, projectName: string) => sidebarOf(page).getByRole('group', { name: projectName })
const looseChatsOf = (page: Page) => sidebarOf(page).getByRole('group', { name: 'Loose chats' })
const chatRowIn = (group: ReturnType<typeof projectGroupOf>, chatName: string) =>
  group.getByRole('link', { name: chatName })
const messageItemsOf = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem')
const tabPanelOf = (page: Page) => page.getByRole('region', { name: 'Side panel' }).getByRole('tabpanel')

const openChat = async (page: Page, chatName: string) => {
  await sidebarOf(page).getByRole('link', { name: chatName }).click()
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: chatName })).toBeVisible()
}

test('shows the seeded Acme sidebar and the Welcome history read through Zero', async ({ page }) => {
  await page.goto('/')
  await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Welcome')).toBeVisible()
  await expect(chatRowIn(projectGroupOf(page, 'Onboarding'), 'Setup helper')).toBeVisible()
  await expect(chatRowIn(projectGroupOf(page, 'Billing'), 'Invoice bug')).toBeVisible()
  await expect(chatRowIn(looseChatsOf(page), 'Standup')).toBeVisible()
  await expect(chatRowIn(looseChatsOf(page), 'Research')).toBeVisible()

  await openChat(page, 'Welcome')
  await expect(messageItemsOf(page)).toHaveCount(2)
  await expect(messageItemsOf(page).nth(0)).toContainText('Bob')
  await expect(messageItemsOf(page).nth(0)).toContainText('09:00')
  await expect(messageItemsOf(page).nth(0)).toContainText('Welcome to the team!')
  await expect(messageItemsOf(page).nth(1)).toContainText('Alice')
  await expect(messageItemsOf(page).nth(1)).toContainText('09:02')
  await expect(messageItemsOf(page).nth(1)).toContainText('Thanks, glad to be here.')
})

test('lists the seeded files of Invoice bug in the Files tab', async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Invoice bug')
  await expect(tabPanelOf(page).getByText('tests', { exact: true })).toBeVisible()
  await expect(tabPanelOf(page).getByText('package.json')).toBeVisible()
  await tabPanelOf(page).getByRole('button', { name: 'billing' }).click()
  await expect(tabPanelOf(page).getByText('invoice.ts', { exact: true })).toBeVisible()
  await expect(tabPanelOf(page).getByText('tax.ts')).toBeVisible()
})

test('switching to Globex shows its sidebar', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.getByRole('menuitem', { name: 'Globex', exact: true }).click()
  await expect(chatRowIn(projectGroupOf(page, 'Launch'), 'Launch plan')).toBeVisible()
  await expect(chatRowIn(looseChatsOf(page), 'General')).toBeVisible()
  await expect(projectGroupOf(page, 'Onboarding')).toHaveCount(0)
})

test.describe('reset between tests', () => {
  test.describe.configure({ mode: 'serial' })

  test('a project inserted through SQL shows up live', async ({ page, workerStack }) => {
    await page.goto('/')
    await expect(projectGroupOf(page, 'Onboarding')).toBeVisible()
    await workerStack.database
      .insert(projects)
      .values({ workspaceId: 'workspace-acme', id: 'project-leftover', name: 'Leftover', archived: false })
    await expect(projectGroupOf(page, 'Leftover')).toBeVisible()
  })

  test('the next test starts from the seed without that project', async ({ page, workerStack }) => {
    expect(await workerStack.database.query.projects.findFirst({ where: { id: 'project-leftover' } })).toBeUndefined()
    await page.goto('/')
    await expect(projectGroupOf(page, 'Onboarding')).toBeVisible()
    await expect(projectGroupOf(page, 'Leftover')).toHaveCount(0)
  })
})
