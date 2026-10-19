import { openPageAs } from '../stack'
import {
  addCredential,
  chipOf,
  expect,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newRuntimeChat,
  newSessionNotice,
  openChat,
  openProfile,
  panelOf,
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('a prompter with only an Anthropic key gets Pi: the command step streams its output, then the answer', {
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
  await expect(chipOf(bobPage, 'hq')).toHaveText('Sonnet 5.5 (medium)')
  await command.getByRole('button', { name: commandText }).click()
  await expect(command).toContainText('one')
  await expect(command).toContainText('two')
  await bobPage.context().close()
})

test('after leaving and reopening the chat, a Pi turn streams each word once and the stored answer matches it', {
  tag: ['@spec-25', '@stage-f'],
}, async ({ page, agentScript, reached, release }) => {
  await openChat(page, 'Research')
  for (const _ of [1, 2]) {
    await openChat(page, 'Welcome')
    await openChat(page, 'Research')
  }
  await agentScript(research, { text: 'Alpha beta gamma delta.', hold: 'stream' })
  await sendMessage(page, 'Stream it')
  await reached('stream')
  const answer = messageContaining(page, 'Alpha')
  await expect(answer).toBeVisible()
  await expect(answer).not.toContainText(/Alpha\s*Alpha/)
  await release('stream')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(answer).toHaveCount(1)
  await expect(answer).toContainText('Alpha beta gamma delta.')
})

test('Stop during a command closes the turn as stopped, and a prompt queued behind it is answered next in the same Pi session', {
  tag: ['@spec-25'],
}, async ({ page, agentScript }) => {
  await openChat(page, 'Research')
  await agentScript(research, { steps: [{ command: 'sleep 30' }], text: 'Never shown.' })
  await sendMessage(page, 'Sleep for a while')
  await expect(messageContaining(page, 'sleep 30').getByRole('img', { name: 'Running' })).toBeVisible()
  await sendMessage(page, 'Carry on')
  await expect(messageContaining(page, 'Carry on')).toHaveCount(1)
  await agentScript(research, { text: 'Carried on.' })
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)

  await expect(messageContaining(page, 'Carried on.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(messageItemsOf(page).nth(0)).toContainText('Sleep for a while')
  await expect(messageItemsOf(page).nth(-3)).toContainText('Stopped by Alice')
  await expect(messageItemsOf(page).nth(-2)).toContainText('Carry on')
  await expect(messageItemsOf(page).nth(-1)).toContainText('Carried on.')
  await expect(mainOf(page)).not.toContainText('Never shown.')
  await expect(mainOf(page)).not.toContainText(newSessionNotice)
})

test('a multi-step Pi turn keeps its plan with update_plan: the latest checklist shows in the Plan tab', {
  tag: ['@spec-25', '@stage-g'],
}, async ({ page, agentScript }) => {
  const chatId = await newRuntimeChat(page, 'Pi keeps a plan')
  await agentScript(chatId, {
    steps: [
      {
        plan: [
          { content: 'Read the totals', status: 'in_progress' },
          { content: 'Fix the tax', status: 'pending' },
        ],
      },
      {
        plan: [
          { content: 'Read the totals', status: 'completed' },
          { content: 'Fix the tax', status: 'in_progress' },
        ],
      },
    ],
    text: 'Tracked in the plan.',
  })
  await sendMessage(page, 'Fix the invoice totals step by step')
  await expect(messageContaining(page, 'Tracked in the plan.')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await panelOf(page).getByRole('tab', { name: 'Plan', exact: true }).click()
  const planItems = panelOf(page).getByRole('tabpanel').getByRole('listitem')
  await expect(planItems).toHaveCount(2)
  await expect(planItems.nth(0)).toContainText('Read the totals')
  await expect(planItems.nth(1)).toContainText('Fix the tax')
})
