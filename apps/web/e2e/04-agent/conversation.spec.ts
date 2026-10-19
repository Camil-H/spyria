import { openPageAs, runtimeStateOf } from '../stack'
import {
  addParticipant,
  agentReplyText,
  expect,
  foldOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  openChat,
  type Page,
  research,
  sendMessage,
  test,
  unreadIconOf,
  workingIndicatorOf,
} from './fixtures'

test.describe('Prompting the agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test.describe('without a runtime yet', () => {
    test.use({ warmRuntimes: false })

    test('the first prompt starts the agent, shown working until its reply arrives', { tag: ['@spec-09'] }, async ({
      page,
      workerStack,
    }) => {
      expect(await runtimeStateOf(workerStack, research)).toBeUndefined()
      await openChat(page, 'Research')
      await sendMessage(page, 'Find the latest pricing')

      await expect(workingIndicatorOf(page)).toBeVisible()
      await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(messageItemsOf(page).nth(0)).toContainText('Find the latest pricing')
      await expect(messageItemsOf(page).nth(1)).toContainText('Agent')
      expect(await runtimeStateOf(workerStack, research)).toBe('running')
    })
  })

  test('the prompt and the reply stay after a reload, and the chat is not unread for the person who prompted', {
    tag: ['@spec-09'],
  }, async ({ page }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'Remember this')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)

    await page.reload()
    await expect(mainOf(page).getByRole('heading', { level: 1, name: 'Research' })).toBeVisible()
    await expect(messageItemsOf(page)).toHaveCount(2)
    await expect(messageItemsOf(page).nth(0)).toContainText('Remember this')
    await expect(messageItemsOf(page).nth(1)).toContainText(agentReplyText)
    await expect(unreadIconOf(page, 'Research')).toHaveCount(0)
  })

  test('a reload during a turn shows the prompt, then the reply once it completes, without a duplicate', {
    tag: ['@spec-09'],
  }, async ({ page, agentScript, release }) => {
    await agentScript(research, { hold: 'answer' })
    await openChat(page, 'Research')
    await sendMessage(page, 'Stream through a reload')
    await expect(messageContaining(page, 'Understood,')).toHaveCount(1)

    await page.reload()
    await expect(messageContaining(page, 'Stream through a reload')).toHaveCount(1)
    await release('answer')
    await expect(messageContaining(page, agentReplyText)).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(2)
  })

  test('another member viewing the chat sees the reply stream in, then the stored reply, and no unread icon', {
    tag: ['@spec-09'],
  }, async ({ page, browser, workerStack, agentScript, release }) => {
    await agentScript(research, { hold: 'answer' })
    await addParticipant(workerStack, research, 'member-bob', 'reader')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Research')
    await openChat(page, 'Research')
    await sendMessage(page, 'Watch this')

    await expect(messageContaining(bobPage, 'Watch this')).toHaveCount(1)
    const bobReply = messageItemsOf(bobPage).nth(1)
    await expect(bobReply).toContainText('Understood,')
    expect(await bobReply.textContent()).not.toContain(agentReplyText)
    await release('answer')
    await expect(bobReply).toContainText(agentReplyText)
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await expect(messageContaining(bobPage, agentReplyText)).toHaveCount(1)
    await expect(unreadIconOf(bobPage, 'Research')).toHaveCount(0)
    await bobPage.context().close()
  })
})

test.describe('Following the agent’s steps', () => {
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
  const stepButtonOf = (page: Page, name: string | RegExp) => messageItemsOf(page).getByRole('button', { name })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openChat(page, 'Research')
  })

  test('the agent’s steps show live while it works: thinking, the running command, its exit code, then the edit', {
    tag: ['@spec-10', '@smoke'],
  }, async ({ page, agentScript, release, heldCommand }) => {
    const steps = fixSteps(`${heldCommand('command')} && `, 'thinking')
    await agentScript(research, { steps, text: fixedText, hold: 'answer' })
    await sendMessage(page, 'Fix the totals')

    await expect(messageContaining(page, 'Thinking…')).toHaveCount(1)
    await release('thinking')
    const command = messageContaining(page, 'python3 --version')
    await expect(command.getByRole('img', { name: 'Running' })).toBeVisible()
    await release('command')
    await expect(command.getByRole('img', { name: 'Succeeded' })).toBeVisible()
    await expect(command).toContainText('exit 0')
    await expect(messageContaining(page, 'Edited totals.ts +2 −1')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toBeVisible()
    await expect(messageContaining(page, fixedText)).toHaveCount(0)
    await release('answer')
    await expect(messageContaining(page, fixedText)).toHaveCount(1)
  })

  test('after the answer the steps fold into one line above it, expand in order, and stay folded after a reload', {
    tag: ['@spec-10'],
  }, async ({ page, agentScript }) => {
    await agentScript(research, { steps: fixSteps(), text: fixedText })
    await sendMessage(page, 'Fix the totals')

    await expect(foldOf(page, 3)).toBeVisible()
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(messageItemsOf(page)).toHaveCount(3)
    await expect(messageItemsOf(page).nth(1)).toContainText(/^Worked for .+ · 3 steps$/)
    await expect(messageItemsOf(page).nth(2)).toContainText(fixedText)
    await foldOf(page, 3).click()
    await expect(foldOf(page, 3)).toHaveAttribute('aria-expanded', 'true')
    await expect(messageItemsOf(page)).toHaveCount(6)
    await expect(messageItemsOf(page).nth(2)).toContainText(/Thought for .+s/)
    await expect(messageItemsOf(page).nth(3)).toContainText('python3 --version')
    await expect(messageItemsOf(page).nth(4)).toContainText('Edited totals.ts +2 −1')
    await expect(messageItemsOf(page).nth(5)).toContainText(fixedText)

    await page.reload()
    await expect(foldOf(page, 3)).toBeVisible()
    await expect(foldOf(page, 3)).toHaveAttribute('aria-expanded', 'false')
    await expect(messageItemsOf(page)).toHaveCount(3)
  })

  test('a reasoning step expands to the reasoning text the agent produced', { tag: ['@spec-10'] }, async ({
    page,
    agentScript,
  }) => {
    await agentScript(research, { steps: [{ think: thinking }] })
    await sendMessage(page, 'Think first')

    const reasoning = stepButtonOf(page, /Thought for .+s/)
    await expect(reasoning).toBeVisible()
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(mainOf(page).getByText(thinking)).toHaveCount(0)
    await reasoning.click()
    await expect(mainOf(page).getByText(thinking)).toBeVisible()
  })

  test('a successful command shows its output on click; a failing one shows exit 3 and its last lines at once', {
    tag: ['@spec-10'],
  }, async ({ page, agentScript }) => {
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
    const failing = messageContaining(page, failingCommand)
    await expect(failing.getByRole('img', { name: 'Failed' })).toBeVisible()
    await expect(failing).toContainText('exit 3')
    await expect(failing).toContainText('step two')
  })

  test('expanding a file edit shows its added and removed lines', { tag: ['@spec-10'] }, async ({
    page,
    agentScript,
  }) => {
    await agentScript(research, { steps: fixSteps(), text: fixedText })
    await sendMessage(page, 'Fix the totals')
    await foldOf(page, 3).click({ timeout: 30_000 })
    const edit = stepButtonOf(page, 'Edited totals.ts +2 −1')
    await edit.click()

    const diff = mainOf(page).getByRole('region', { name: 'Diff' })
    await expect(diff).toContainText('- export const total = 1')
    await expect(diff).toContainText('+ export const total = 2')
    await expect(diff).toContainText('+ export const tax = 0.2')
  })

  test('Markdown answers render tables, highlighted code with copy (✓ Copied for a moment, the code in the clipboard), links with their domain, raw HTML as text and images on click', {
    tag: ['@spec-10', '@spec-25', '@stage-g'],
  }, async ({ page, context, agentScript }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
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

    const reply = messageContaining(page, 'See the pricing')
    await expect(reply.getByRole('table')).toBeVisible()
    await expect(reply.getByRole('cell', { name: 'Team' })).toBeVisible()
    await expect(reply.locator('code .hljs-keyword').first()).toHaveText('const')
    const copyCode = reply.getByRole('button', { name: 'Copy code' })
    await expect(copyCode).toHaveText('Copy')
    await copyCode.click()
    await expect(copyCode).toHaveText('✓ Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const total = 1')
    await expect(copyCode).toHaveText('Copy', { timeout: 4000 })
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
})
