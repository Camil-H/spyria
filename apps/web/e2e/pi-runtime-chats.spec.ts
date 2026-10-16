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
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs } from './stack'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('8 and 9. a prompter with only an Anthropic key gets Pi: the command step streams its output, then the answer', async ({
  browser,
  workerStack,
  agentScript,
  release,
  heldCommand,
}) => {
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
  await expect(chipOf(bobPage, 'hq')).toHaveText('Sonnet 5.5 (medium) · auto')
  await command.getByRole('button', { name: commandText }).click()
  await expect(command).toContainText('one')
  await expect(command).toContainText('two')
  await bobPage.context().close()
})

test('11. Stop during a command closes the turn as stopped, and a prompt queued behind it is answered next in the same Pi session', async ({
  page,
  agentScript,
}) => {
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
