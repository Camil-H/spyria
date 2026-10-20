import {
  expect,
  messageContaining,
  newSession,
  runsOnChipOf,
  sendMessage,
  signedInMachine,
  machineTest as test,
} from './fixtures'

test.describe('Harness install on my machine', () => {
  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  const runtimeStatusOf = (page: Parameters<typeof runsOnChipOf>[0]) =>
    runsOnChipOf(page).getByRole('status', { name: 'Runtime' })

  test('As a member, I start a Claude Code session on my machine with nothing installed: the chat shows Installing Claude Code…, then my turn runs', {
    tag: ['@spec-51'],
  }, async ({ page, machine }) => {
    await machine({ ...signedInMachine, holdInstall: 'true' })
    await newSession(page, 'Claude Code')
    await expect(runtimeStatusOf(page)).toHaveText('Installing Claude Code…')
    await machine({ holdInstall: 'false' })
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Hello')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    expect((await machine()).installs).toBe(1)
  })

  test('As a member, I start a second Claude Code session on my machine and it starts with no install step', {
    tag: ['@spec-51'],
  }, async ({ page, machine }) => {
    await machine(signedInMachine)
    await newSession(page, 'Claude Code', 'First session')
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await newSession(page, 'Claude Code', 'Second session')
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Hello again')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    expect((await machine()).installs).toBe(1)
  })

  test("As a member, a failed install shows npm's reason and a Retry, and Retry installs and runs my turn", {
    tag: ['@spec-51'],
  }, async ({ page, machine }) => {
    const reason =
      "code E404\n404 Not Found - GET http://registry.invalid/@anthropic-ai%2fclaude-code - '@anthropic-ai/claude-code@2.1.296' is not in this registry."
    await machine({ ...signedInMachine, installFailure: reason })
    await newSession(page, 'Claude Code')
    await expect(runtimeStatusOf(page).getByRole('button', { name: 'Could not start · Retry' })).toBeVisible()
    await expect(runtimeStatusOf(page)).toContainText("'@anthropic-ai/claude-code@2.1.296' is not in this registry.")
    await machine({ installFailure: '' })
    await runtimeStatusOf(page).getByRole('button', { name: 'Could not start · Retry' }).click()
    await expect(runtimeStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Hello')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    expect((await machine()).installs).toBe(2)
  })
})
