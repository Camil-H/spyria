import { openPageAs } from '../stack'
import {
  configureGitHubApp,
  connectGitHub,
  expect,
  mainOf,
  messageContaining,
  messageItemsOf,
  newDevChat,
  openSettings,
  type Page,
  sendMessage,
  test,
} from './fixtures'

const sectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Quality gates' })
const gatesOf = (page: Page) => sectionOf(page).getByRole('list', { name: 'Gates' }).locator(':scope > li')
const tabOf = (page: Page, name: string) =>
  sectionOf(page).getByRole('tablist', { name: 'Rules' }).getByRole('tab', { name, exact: true })
const switchOf = (page: Page) =>
  sectionOf(page).getByRole('switch', { name: 'Agents in dev chats go through these gates' })

test.describe('Quality gates settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As an admin, I turn the default rules on, add rules for a repository with a command before the default gates, its own switch and limits, which stay after a reload; a member who cannot connect GitHub is refused the page', {
    tag: ['@spec-57'],
  }, async ({ page, browser, workerStack }) => {
    await configureGitHubApp(page)
    await openSettings(page, 'Quality gates')
    const section = sectionOf(page)
    await expect(tabOf(page, 'Default rules')).toHaveAttribute('aria-selected', 'true')
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(gatesOf(page)).toHaveCount(3)
    await expect(gatesOf(page).nth(2)).toHaveAttribute('aria-label', 'Gate 3: CI')
    await switchOf(page).click()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')

    await tabOf(page, 'New repository rules').click()
    await section.getByRole('combobox', { name: 'Repository' }).selectOption('acme/app')
    await expect(tabOf(page, 'acme/app')).toHaveAttribute('aria-selected', 'true')
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')
    await section.getByRole('button', { name: 'Command', exact: true }).click()
    const command = gatesOf(page).nth(1)
    await expect(command).toHaveAttribute('aria-label', 'Gate 2: Command')
    await command.getByLabel('Name').fill('Lint')
    await command.getByLabel('Command', { exact: true }).fill('bun run lint')
    await section.getByRole('button', { name: 'Move Lint up' }).click()
    await expect(gatesOf(page).nth(0)).toHaveAttribute('aria-label', 'Gate 1: Lint')
    await section.getByLabel('Time limit (minutes)').fill('60')
    await switchOf(page).click()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()

    await page.reload()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'true')
    await expect(gatesOf(page)).toHaveCount(3)
    await tabOf(page, 'acme/app').click()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(gatesOf(page)).toHaveCount(4)
    await expect(gatesOf(page).nth(0).getByLabel('Command', { exact: true })).toHaveValue('bun run lint')
    await expect(section.getByLabel('Time limit (minutes)')).toHaveValue('60')

    const leePage = await openPageAs(browser, workerStack, 'member-lee')
    await leePage.goto('/w/workspace-acme/settings/quality-gates')
    await expect(mainOf(leePage)).toContainText('Your workspace role does not give access to this page')
    await expect(mainOf(leePage).getByRole('region', { name: 'Quality gates' })).toHaveCount(0)
    await leePage.context().close()

    await section.getByRole('button', { name: 'Delete the rules of acme/app' }).click()
    await expect(tabOf(page, 'Default rules')).toHaveAttribute('aria-selected', 'true')
    await switchOf(page).click()
    await section.getByRole('button', { name: 'Save' }).click()
    await expect(section.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(switchOf(page)).toHaveAttribute('aria-checked', 'false')
    await expect(tabOf(page, 'acme/app')).toHaveCount(0)
  })
})

test.describe('Quality gates card', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As the owner, I see the Quality gates card under the latest messages when the gates start again, with "Starting again from Lint"', {
    tag: ['@spec-57'],
  }, async ({ page, agentScript, heldCommand, release, workerStack }) => {
    const lint = {
      kind: 'command',
      name: 'Lint',
      command: `grep -q fixed src/app.ts && ${heldCommand('lint')}`,
      timeoutMinutes: 5,
      fixes: 2,
    }
    const rules = { repository: 'acme/app', isOn: true, timeLimitMinutes: 240, costLimitMicros: null, steps: [lint] }
    await workerStack.database.$client`
      update workspaces set dev_loop = ${JSON.stringify({ rules: [rules] })}::jsonb where workspace_id = 'workspace-acme'`
    await configureGitHubApp(page)
    await connectGitHub(page)
    const chatId = await newDevChat(page, 'Gated totals', 'acme/app')
    const committing = (oldText: string, newText: string, subject: string) => [
      { edit: { path: 'src/app.ts', oldText, newText } },
      { command: `git -c user.name='Pi Agent' -c user.email=agent@example.com commit -qam '${subject}'` },
      { tool: 'finish_work', arguments: { title: 'Fix the totals', body: 'The totals add up' } },
    ]
    await agentScript(chatId, {
      steps: committing('export const total = 1\n', 'export const total = 2\n', 'Fix the totals'),
      text: 'Done.',
      whenPrompted: [
        {
          includes: "Quality gates ran the repository's checks",
          script: {
            steps: committing('export const total = 2\n', 'export const total = 2 // fixed\n', 'Fix lint'),
            text: 'Fixed lint.',
          },
        },
      ],
    })
    await sendMessage(page, 'Fix the totals')

    const card = messageItemsOf(page).getByRole('region', { name: 'Quality gates' })
    await expect(card).toContainText('Starting again from Lint (round 2)')
    await expect(card.getByRole('img', { name: 'running' })).toHaveCount(1)
    await expect(messageContaining(page, 'Quality gates: round 2, see below')).toHaveCount(1)
    await expect(messageContaining(page, 'Fixed lint.')).toHaveCount(1)
    const order = () =>
      messageItemsOf(page).evaluateAll((items) =>
        items
          .map((item) =>
            item.querySelector('[aria-label="Quality gates"]')
              ? 'card'
              : item.textContent?.includes('see below')
                ? 'marker'
                : item.textContent?.includes('Fixed lint.')
                  ? 'fix'
                  : null,
          )
          .filter(Boolean),
      )
    await expect.poll(order).toEqual(['marker', 'fix', 'card'])

    await release('lint')
    await expect(card).toContainText('Ready for your review: Lint passed')
    await expect(card).not.toContainText('Starting again')
    await expect.poll(order).toEqual(['marker', 'fix', 'card'])
  })
})
