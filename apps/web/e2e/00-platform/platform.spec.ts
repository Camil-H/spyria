import { projects } from '@spyria/db/postgres'
import {
  agentReplyText,
  expect,
  messageContaining,
  openChat,
  projectGroupOf,
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from '../fixtures'
import { openPageAs } from '../stack'

test.describe('Platform', () => {
  test('As a member, I see a project inserted through SQL show up live', { tag: ['@smoke'] }, async ({
    page,
    workerStack,
  }) => {
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

  test('As a member, I find the seed again after a reset: a project inserted before it is gone', async ({
    browser,
    workerStack,
  }) => {
    await workerStack.database.insert(projects).values({
      workspaceId: 'workspace-acme',
      id: 'project-leftover',
      name: 'Leftover',
      archived: false,
      createdAt: new Date(),
    })
    await workerStack.reset({ runtimeHost: true, warmRuntimes: true, sharedCrm: true })
    expect(await workerStack.database.query.projects.findFirst({ where: { id: 'project-leftover' } })).toBeUndefined()
    const page = await openPageAs(browser, workerStack, 'member-alice')
    await expect(projectGroupOf(page, 'Onboarding')).toBeVisible()
    await expect(projectGroupOf(page, 'Leftover')).toHaveCount(0)
    await page.context().close()
  })

  test('As a member, I create a project in the browser and the server stores it', async ({ page, workerStack }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Project creation' }).click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Canary')
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(projectGroupOf(page, 'Canary')).toBeVisible()
    await expect
      .poll(async () => (await workerStack.database.$client`select 1 from projects where name = 'Canary'`).length)
      .toBe(1)
    await page.reload()
    await expect(projectGroupOf(page, 'Canary')).toBeVisible()
  })

  test('As a member, I receive the agent stream frame of a scripted turn', async ({ page, agentScript, release }) => {
    const frames: string[] = []
    page.on('websocket', (socket) => {
      if (socket.url().endsWith('/api/stream'))
        socket.on('framereceived', ({ payload }) => frames.push(String(payload)))
    })
    await agentScript(research, { hold: 'answer' })
    await page.goto('/')
    await openChat(page, 'Research')
    await sendMessage(page, 'Stream a frame')
    await expect.poll(() => frames.some((frame) => frame.includes('Understood,'))).toBe(true)
    await release('answer')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
  })

  test('As a member, my prompt’s model call goes through the gateway and is recorded with its prompter and owner', async ({
    page,
    workerStack,
  }) => {
    await page.goto('/')
    await openChat(page, 'Research')
    await sendMessage(page, 'Call the model once')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect
      .poll(async () =>
        (
          await workerStack.database.$client`
            select distinct prompter_id, owner_id, status from model_calls where chat_id = ${research}`
        ).map((call) => ({ ...call })),
      )
      .toEqual([{ prompter_id: 'member-alice', owner_id: 'member-alice', status: 'success' }])
  })
})
