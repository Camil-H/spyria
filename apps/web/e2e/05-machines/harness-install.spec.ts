import {
  expect,
  messageContaining,
  newSession,
  runsOnStatusOf,
  sendMessage,
  signedInMachine,
  machineTest as test,
} from './fixtures'

test.describe('Harness install on my machine', () => {
  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('As a member, I start a Claude Code session on my machine with nothing installed: the chat shows Installing Claude Code…, then my turn runs', {
    tag: ['@spec-51'],
  }, async ({ page, machine }) => {
    await machine({ ...signedInMachine, holdInstall: 'true' })
    await newSession(page, 'Claude Code')
    await expect(runsOnStatusOf(page)).toHaveText('Installing Claude Code…')
    await machine({ holdInstall: 'false' })
    await expect(runsOnStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Hello')
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
    await expect(runsOnStatusOf(page).getByRole('button', { name: 'Could not start · Retry' })).toBeVisible()
    await expect(runsOnStatusOf(page)).toContainText("'@anthropic-ai/claude-code@2.1.296' is not in this registry.")
    await machine({ installFailure: '' })
    await runsOnStatusOf(page).getByRole('button', { name: 'Could not start · Retry' }).click()
    await expect(runsOnStatusOf(page)).toHaveText('Ready')
    await sendMessage(page, 'Hello')
    await expect(messageContaining(page, '[t1] Hello from the stub')).toBeVisible()
    expect((await machine()).installs).toBe(2)
  })
})
