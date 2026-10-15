import {
  expect,
  mainOf,
  messageItemsOf,
  openChat,
  type Page,
  panelOf,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'

const research = 'chat-research'
const thinking = 'I will check the toolchain, then fix the totals.'
const fixedText = 'Fixed the totals and added the tax line.'
const createTotals = `python3 --version && printf 'export const total = 1\\n' > totals.ts`
const fixSteps = (commandPrefix = '', thinkingHold?: string) => [
  { think: thinking, hold: thinkingHold },
  { command: `${commandPrefix}${createTotals}` },
  {
    edit: {
      path: 'totals.ts',
      oldText: 'export const total = 1\n',
      newText: 'export const total = 2\nexport const tax = 0.2\n',
    },
  },
]
const failingCommand = `bash -c 'echo step one; echo step two; exit 3'`
const itemsWith = (page: Page, text: string | RegExp) => messageItemsOf(page).filter({ hasText: text })
const stepButtonOf = (page: Page, name: string | RegExp) => messageItemsOf(page).getByRole('button', { name })
const foldOf = (page: Page) => stepButtonOf(page, /^Worked for .+ · 3 steps$/)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Research')
})

test('11. steps show live while the agent works: thinking, the running command, its exit code, then the edit', async ({
  page,
  agentScript,
  release,
  heldCommand,
}) => {
  const steps = fixSteps(`${heldCommand('command')} && `, 'thinking')
  await agentScript(research, { steps, text: fixedText, hold: 'answer' })
  await sendMessage(page, 'Fix the totals')

  await expect(itemsWith(page, 'Thinking…')).toHaveCount(1)
  await release('thinking')
  const command = itemsWith(page, 'python3 --version')
  await expect(command.getByRole('img', { name: 'Running' })).toBeVisible()
  await release('command')
  await expect(command.getByRole('img', { name: 'Succeeded' })).toBeVisible()
  await expect(command).toContainText('exit 0')
  await expect(itemsWith(page, 'Edited totals.ts +2 −1')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toBeVisible()
  await expect(itemsWith(page, fixedText)).toHaveCount(0)
  await release('answer')
  await expect(itemsWith(page, fixedText)).toHaveCount(1)
})

test('12. after the answer the steps fold into one line above it, expand in order, and stay folded after a reload', async ({
  page,
  agentScript,
}) => {
  await agentScript(research, { steps: fixSteps(), text: fixedText })
  await sendMessage(page, 'Fix the totals')

  await expect(foldOf(page)).toBeVisible()
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page)).toHaveCount(3)
  await expect(messageItemsOf(page).nth(1)).toContainText(/^Worked for .+ · 3 steps$/)
  await expect(messageItemsOf(page).nth(2)).toContainText(fixedText)
  await foldOf(page).click()
  await expect(foldOf(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(messageItemsOf(page)).toHaveCount(6)
  await expect(messageItemsOf(page).nth(2)).toContainText(/Thought for .+s/)
  await expect(messageItemsOf(page).nth(3)).toContainText('python3 --version')
  await expect(messageItemsOf(page).nth(4)).toContainText('Edited totals.ts +2 −1')
  await expect(messageItemsOf(page).nth(5)).toContainText(fixedText)

  await page.reload()
  await expect(foldOf(page)).toBeVisible()
  await expect(foldOf(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(messageItemsOf(page)).toHaveCount(3)
})

test('13. a reasoning step expands to the reasoning text the agent produced', async ({ page, agentScript }) => {
  await agentScript(research, { steps: [{ think: thinking }] })
  await sendMessage(page, 'Think first')

  const reasoning = stepButtonOf(page, /Thought for .+s/)
  await expect(reasoning).toBeVisible()
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(mainOf(page).getByText(thinking)).toHaveCount(0)
  await reasoning.click()
  await expect(mainOf(page).getByText(thinking)).toBeVisible()
})

test('14. a successful command shows its output on click; a failing one shows exit 3 and its last lines at once', async ({
  page,
  agentScript,
}) => {
  await agentScript(research, { steps: [{ command: 'echo all good' }] })
  await sendMessage(page, 'Run the good command')
  const good = stepButtonOf(page, 'echo all good')
  await expect(good).toBeVisible()
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(mainOf(page).getByText('all good', { exact: true })).toHaveCount(0)
  await good.click()
  await expect(mainOf(page).getByText('all good', { exact: true })).toBeVisible()

  await agentScript(research, { steps: [{ command: failingCommand }] })
  await sendMessage(page, 'Run the failing command')
  const failing = itemsWith(page, failingCommand)
  await expect(failing.getByRole('img', { name: 'Failed' })).toBeVisible()
  await expect(failing).toContainText('exit 3')
  await expect(failing).toContainText('step two')
})

test('15. expanding a file edit shows its added and removed lines', async ({ page, agentScript }) => {
  await agentScript(research, { steps: fixSteps(), text: fixedText })
  await sendMessage(page, 'Fix the totals')
  await foldOf(page).click({ timeout: 30_000 })
  const edit = stepButtonOf(page, 'Edited totals.ts +2 −1')
  await edit.click()

  const diff = mainOf(page).getByRole('region', { name: 'Diff' })
  await expect(diff).toContainText('- export const total = 1')
  await expect(diff).toContainText('+ export const total = 2')
  await expect(diff).toContainText('+ export const tax = 0.2')
})

test('16. a plan shows as one checklist in its latest state and feeds the Plan tab', async ({ page, agentScript }) => {
  await agentScript(research, {
    steps: [
      {
        plan: [
          { title: 'Reproduce the bug', status: 'done' },
          { title: 'Fix the totals', status: 'in_progress' },
        ],
      },
      {
        plan: [
          { title: 'Reproduce the bug', status: 'done' },
          { title: 'Fix the totals', status: 'done' },
        ],
      },
    ],
  })
  await sendMessage(page, 'Plan the fix')

  await expect(workingIndicatorOf(page)).toHaveCount(0)
  const checklist = mainOf(page).getByRole('group', { name: 'Plan' })
  await expect(checklist).toHaveCount(1)
  await expect(checklist.getByRole('checkbox', { name: 'Fix the totals' })).toBeChecked()
  await expect(checklist.getByRole('checkbox', { name: 'Reproduce the bug' })).toBeChecked()
  await panelOf(page).getByRole('tab', { name: 'Plan', exact: true }).click()
  await expect(panelOf(page).getByRole('tabpanel').getByRole('listitem')).toHaveCount(2)
  await expect(panelOf(page).getByRole('tabpanel')).toContainText('Fix the totals')
  await expect(panelOf(page).getByRole('tabpanel')).not.toContainText('In progress')
})

test('17. an agent failure shows a red error notice and ends the turn', async ({ page, agentScript }) => {
  await agentScript(research, { steps: [{ fail: 'The model is overloaded' }] })
  await sendMessage(page, 'Try anyway')

  const error = messageItemsOf(page).getByRole('alert')
  await expect(error).toContainText('The provider is unavailable, try again shortly')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
})

test('18. Markdown answers render tables, highlighted code with copy, links with their domain, raw HTML as text and images on click', async ({
  page,
  agentScript,
}) => {
  const answer = [
    '| Plan | Price |',
    '| --- | --- |',
    '| Team | 20 |',
    '',
    '```ts',
    'const total = 1',
    '```',
    '',
    'See [the pricing](https://docs.example.com/pricing).',
    '',
    '<script>window.hqInjected = true</script>',
    '',
    'Inline <img src="x" onerror="window.hqInjected = true"> tag.',
    '',
    '![Chart](https://images.example.com/chart.png)',
  ].join('\n')
  await agentScript(research, { text: answer })
  await sendMessage(page, 'Show the pricing')

  const reply = itemsWith(page, 'See the pricing')
  await expect(reply.getByRole('table')).toBeVisible()
  await expect(reply.getByRole('cell', { name: 'Team' })).toBeVisible()
  await expect(reply.locator('code .hljs-keyword').first()).toHaveText('const')
  await expect(reply.getByRole('button', { name: 'Copy code' })).toBeVisible()
  const link = reply.getByRole('link', { name: /the pricing/ })
  await expect(link).toContainText('docs.example.com')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(reply).toContainText('<script>window.hqInjected = true</script>')
  await expect(reply).toContainText('<img src="x" onerror="window.hqInjected = true">')
  expect(await page.evaluate(() => (window as Window & { hqInjected?: boolean }).hqInjected)).toBeUndefined()
  await expect(reply.locator('img')).toHaveCount(0)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await reply.getByRole('button', { name: 'Load image from images.example.com' }).click()
  await expect(reply.locator('img')).toHaveAttribute('src', 'https://images.example.com/chart.png')
})
