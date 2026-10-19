import { projects } from '@hq/db/postgres'
import { expect, projectGroupOf, test } from '../fixtures'

test.describe.configure({ mode: 'serial' })

test('a project inserted through SQL shows up live', { tag: ['@smoke'] }, async ({ page, workerStack }) => {
  await page.goto('/')
  await expect(projectGroupOf(page, 'Onboarding')).toBeVisible()
  await workerStack.database.insert(projects).values({
    workspaceId: 'workspace-acme',
    id: 'project-leftover',
    name: 'Leftover',
    archived: false,
    createdAt: new Date(),
  })
  await expect(projectGroupOf(page, 'Leftover')).toBeVisible()
})

test('the next test starts from the seed without that project', async ({ page, workerStack }) => {
  expect(await workerStack.database.query.projects.findFirst({ where: { id: 'project-leftover' } })).toBeUndefined()
  await page.goto('/')
  await expect(projectGroupOf(page, 'Onboarding')).toBeVisible()
  await expect(projectGroupOf(page, 'Leftover')).toHaveCount(0)
})
