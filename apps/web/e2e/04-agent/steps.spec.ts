import { openPageAs } from '../stack'
import {
  addCredential,
  chipOf,
  expect,
  foldOf,
  forEachHarness,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newHarnessChat,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  research,
  sendMessage,
  sessionStarted,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'

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
const openCommandStep = async (page: Page, command: string) => {
  const step = messageContaining(page, `$ ${command}`)
  await step.getByRole('button', { expanded: false }).click()
  return step
}

test.describe('Steps', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  forEachHarness((harness) => {
    test(`As a prompter, I follow the agent’s steps live while it works, then see them folded before its answer [${harness.name}]`, {
      tag: ['@spec-10', '@spec-21', '@spec-25', ...(harness.name === 'Codex' ? [] : ['@smoke'])],
    }, async ({ page, agentScript, release, heldCommand, machine, workerStack }) => {
      if (harness.name === 'Pi') {
        await openChat(page, 'Research')
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
        return
      }
      await newHarnessChat(page, harness, `${harness.name} steps`, { machine, workerStack })
      if (harness.name === 'Claude Code') {
        await sendMessage(page, 'stub:tools stub:linger')
        await expect(messageContaining(page, '[t1]')).toBeVisible()
        await expect(workingIndicatorOf(page)).toBeVisible()
        await release('linger')
        await expect(foldOf(page, 2)).toBeVisible()
        await expect(workingIndicatorOf(page)).toHaveCount(0)
        await test.step('text streamed before the steps stays before them, the answer after them', async () => {
          await expect(messageItemsOf(page)).toHaveCount(4)
          await expect(messageItemsOf(page).nth(1)).toContainText('[t1]')
          await expect(messageItemsOf(page).nth(2)).toContainText(/^Worked for .+ · 2 steps$/)
          await expect(messageItemsOf(page).nth(3)).toContainText('Hello from the stub')
          await expect(messageItemsOf(page).nth(3)).not.toContainText('[t1]')
        })
        await foldOf(page, 2).click()
        const edit = messageContaining(page, 'Edited app.ts +1 −1')
        await expect(edit).toHaveCount(1)
        await edit.getByRole('button').click()
        await expect(edit).toContainText('one')
        await expect(edit).toContainText('two')
        await expect(messageContaining(page, '$ npm test')).toContainText('exit 1')
        await expect(mainOf(page)).not.toContainText('$ Terminal')
        await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(1)

        await page.reload()
        await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(1)
        await expect(messageContaining(page, '[t1]')).toHaveCount(1)
        return
      }
      await sendMessage(page, 'stub:read stub:tools stub:linger')
      await expect(messageContaining(page, '$ npm test').getByRole('img', { name: 'Failed' })).toBeVisible()
      await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
      await expect(page.getByRole('status', { name: 'Agent is working' })).toBeVisible()
      await release('linger')
      await expect(page.getByRole('status', { name: 'Agent is working' })).toHaveCount(0)
      await messageItemsOf(page)
        .getByRole('button', { name: /^Worked for .+ · 3 steps$/ })
        .click()
      await expect(messageContaining(page, 'Read notes.md')).toBeVisible()
      const command = messageContaining(page, '$ npm test')
      await expect(command.getByRole('img', { name: 'Failed' })).toBeVisible()
      await expect(messageItemsOf(page).getByRole('img', { name: 'Running' })).toHaveCount(0)
      await expect(mainOf(page)).not.toContainText('$ Terminal')
      await expect(mainOf(page)).not.toContainText('Read File')
    })
  })

  test.describe(() => {
    test.beforeEach(async ({ page }) => {
      await openChat(page, 'Research')
    })

    test('As a prompter, I see the steps fold into one line above the answer, expand in order, and stay folded after a reload', {
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

    test('As a prompter, I expand a reasoning step to the reasoning text the agent produced', {
      tag: ['@spec-10'],
    }, async ({ page, agentScript }) => {
      await agentScript(research, { steps: [{ think: thinking }] })
      await sendMessage(page, 'Think first')

      const reasoning = stepButtonOf(page, /Thought for .+s/)
      await expect(reasoning).toBeVisible()
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await expect(mainOf(page).getByText(thinking)).toHaveCount(0)
      await reasoning.click()
      await expect(mainOf(page).getByText(thinking)).toBeVisible()
    })

    test('As a prompter, I open a successful command’s output on click, and a failing one shows exit 3 and its last lines at once', {
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

    test('As a prompter, I expand a file edit to its added and removed lines', { tag: ['@spec-10'] }, async ({
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

    test('As a prompter, I read Markdown answers with tables, highlighted code with copy (✓ Copied for a moment, the code in the clipboard), links with their domain, raw HTML as text and images on click', {
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
        '<script>window.spyriaInjected = true</script>',
        '',
        'Inline <img src="x" onerror="window.spyriaInjected = true"> tag.',
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
      await expect(reply).toContainText('<script>window.spyriaInjected = true</script>')
      await expect(reply).toContainText('<img src="x" onerror="window.spyriaInjected = true">')
      expect(
        await page.evaluate(() => (window as Window & { spyriaInjected?: boolean }).spyriaInjected),
      ).toBeUndefined()
      await expect(reply.locator('img')).toHaveCount(0)
      await expect(workingIndicatorOf(page)).toHaveCount(0)
      await reply.getByRole('button', { name: 'Load image from images.example.com' }).click()
      await expect(reply.locator('img')).toHaveAttribute('src', 'https://images.example.com/chart.png')
    })

    test('As a prompter, I see a running command’s output live in its step, then its exit code', {
      tag: ['@spec-40'],
    }, async ({ page, agentScript, heldCommand, release }) => {
      const command = `printf 'running 3 tests\\n' && ${heldCommand('tests')} && printf '3 passed\\n'`
      await agentScript(research, { steps: [{ command }], text: 'The tests pass.' })
      await sendMessage(page, 'Run the tests')
      const step = await openCommandStep(page, command)
      const output = step.locator('pre')
      await expect(output).toContainText('running 3 tests')
      await expect(step.getByRole('img', { name: 'Running' })).toBeVisible()
      await expect(output).not.toContainText(/running 3 tests\s+3 passed/)
      await release('tests')
      await expect(output).toContainText(/running 3 tests\s+3 passed/)
      await expect(step).toContainText('exit 0')
    })
  })

  test('As a prompter with only an Anthropic key, I get Pi on Sonnet 5.5: the command step streams its output, then the answer', {
    tag: ['@spec-25'],
  }, async ({ browser, workerStack, agentScript, release, heldCommand }) => {
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openProfile(bobPage)
    await addCredential(bobPage, { provider: 'Anthropic', secret: `fake-key-${crypto.randomUUID()}` })
    await expect(llmSectionOf(bobPage).getByRole('listitem').filter({ hasText: 'Anthropic' })).toBeVisible()
    const chatId = await newRuntimeChat(bobPage, 'Bob on Anthropic')
    const commandText = `echo one; ${heldCommand('command')}; echo two`
    await agentScript(chatId, { steps: [{ command: commandText }], text: 'Answered on Sonnet 5.5.' })
    await sendMessage(bobPage, 'Run it on Pi')

    const command = messageContaining(bobPage, commandText)
    await expect(command.getByRole('img', { name: 'Running' })).toBeVisible()
    await release('command')
    await expect(command.getByRole('img', { name: 'Succeeded' })).toBeVisible()
    await expect(messageContaining(bobPage, 'Answered on Sonnet 5.5.')).toHaveCount(1)
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await expect(chipOf(bobPage, 'spyria')).toHaveText('Sonnet 5.5 (medium)')
    await command.getByRole('button', { name: commandText }).click()
    await expect(command).toContainText('one')
    await expect(command).toContainText('two')
    await bobPage.context().close()
  })

  test('As a prompter, I see the plan a Pi agent keeps with update_plan as one checklist in its latest state, with no tool step', {
    tag: ['@spec-25', '@stage-e', '@stage-g'],
  }, async ({ page, workerStack, agentScript }) => {
    const chatId = await newRuntimeChat(page, 'Pi plan')
    const plan = [
      { content: 'Reproduce the bug', status: 'completed' },
      { content: 'Fix the totals', status: 'in_progress' },
      { content: 'Ship', status: 'pending' },
    ]
    const firstPlan = plan.map((item, index) => ({ ...item, status: index === 0 ? 'in_progress' : 'pending' }))
    await agentScript(chatId, { steps: [{ plan: firstPlan }, { plan }], text: 'Planned the fix.' })
    await sendMessage(page, 'Plan the fix')
    await sessionStarted(workerStack, chatId)
    const checklist = mainOf(page).getByRole('group', { name: 'Plan' })
    await expect(checklist).toBeVisible()
    await expect(messageContaining(page, 'Planned the fix.')).toHaveCount(1)
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await expect(checklist).toHaveCount(1)
    await expect(checklist.getByRole('checkbox', { name: 'Reproduce the bug' })).toBeChecked()
    await expect(checklist.getByRole('checkbox', { name: 'Ship' })).not.toBeChecked()
    await expect(mainOf(page)).not.toContainText('update_plan')
  })
})
