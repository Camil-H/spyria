import { openPageAs, type WorkerStack } from '../stack'
import {
  accountOf,
  addLlmKey,
  addParticipant,
  connectFake,
  expect,
  lastToolResultOf,
  messageItemsOf,
  openChat,
  type Page,
  promptTool,
  research,
  sendMessage,
  test,
  toolScript,
  workingIndicatorOf,
} from './fixtures'

const updateScript = (text: string) => ({
  steps: [{ tool: 'crm-update', arguments: { text: 'Renewal on 1 May' } }],
  text,
})
const approvalCardOf = (page: Page) => messageItemsOf(page).getByRole('region', { name: 'Tool approval' })
const updateStepOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: 'Used update (crm)' })

const openAsBob = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
  await addParticipant(workerStack, research, 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Mistral')
  await openChat(bobPage, 'Research')
  return bobPage
}

test.describe('Guest rights', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openChat(page, 'Research')
  })

  test('As a prompter in someone’s chat, I cannot use the owner’s personal connection: the agent gets a refusal, while the owner’s own prompt uses it', {
    tag: ['@spec-33', '@smoke'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const account = accountOf('alice-acme')
    await connectFake(page, account)
    await addParticipant(workerStack, research, 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await addLlmKey(bobPage, 'Mistral')
    await promptTool(bobPage, agentScript, 'Bob asks who the agent is', {
      ...toolScript,
      text: 'I cannot use Alice’s personal connections.',
    })
    await expect(await lastToolResultOf(bobPage)).toContainText(
      "fake is Alice's personal connection, used only on Alice's own prompts",
    )
    await expect(messageItemsOf(bobPage).filter({ hasText: 'I cannot use Alice’s personal connections.' })).toHaveCount(
      1,
    )
    await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Connect fake' })).toHaveCount(0)

    await promptTool(page, agentScript, 'Alice asks who the agent is')
    await expect(await lastToolResultOf(page)).toContainText(`you are ${account}`)
    await bobPage.context().close()
  })

  test('As a guest, my write call waits for the owner’s approval, and once approved it runs and the reply continues', {
    tag: ['@spec-33'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openAsBob(browser, workerStack)
    await agentScript(research, updateScript('Updated the record.'))
    await sendMessage(bobPage, 'Bob asks to update the record')
    await expect(approvalCardOf(page)).toContainText('Bob asks to run update (crm)')
    await expect(approvalCardOf(page)).toContainText('{"text":"Renewal on 1 May"}')
    await expect(approvalCardOf(bobPage)).toContainText("Waiting for Alice's approval")
    await expect(approvalCardOf(bobPage).getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Waiting to use update (crm)' })).toBeVisible()
    await expect(updateStepOf(bobPage)).toHaveCount(0)

    await approvalCardOf(page).getByRole('button', { name: 'Approve' }).click()
    await expect(approvalCardOf(bobPage)).toContainText('Approved by Alice')
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await updateStepOf(bobPage).click()
    await expect(messageItemsOf(bobPage).filter({ hasText: 'ran update' })).not.toHaveCount(0)
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Updated the record.' })).toHaveCount(1)
    await bobPage.context().close()
  })

  test('As a chat owner, I deny a guest’s write call: the agent gets the refusal and says so, and the card reads Denied by Alice', {
    tag: ['@spec-33'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openAsBob(browser, workerStack)
    await agentScript(research, updateScript('Alice did not approve the update.'))
    await sendMessage(bobPage, 'Bob asks to update the record')
    await approvalCardOf(page).getByRole('button', { name: 'Deny' }).click()
    await expect(approvalCardOf(bobPage)).toContainText('Denied by Alice')
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await updateStepOf(bobPage).click()
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Alice did not approve this call' })).not.toHaveCount(0)
    await expect(messageItemsOf(bobPage).filter({ hasText: 'Alice did not approve the update.' })).toHaveCount(1)
    await bobPage.context().close()
  })

  test('As a guest, my read-only call runs without approval', { tag: ['@spec-33'] }, async ({
    page,
    browser,
    workerStack,
    agentScript,
  }) => {
    const bobPage = await openAsBob(browser, workerStack)
    await agentScript(research, { steps: [{ tool: 'crm-lookup' }], text: 'Looked the record up.' })
    await sendMessage(bobPage, 'Bob asks to look the record up')
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await messageItemsOf(bobPage).getByRole('button', { name: 'Used lookup (crm)' }).click()
    await expect(messageItemsOf(bobPage).filter({ hasText: 'ran lookup' })).not.toHaveCount(0)
    await expect(approvalCardOf(bobPage)).toHaveCount(0)
    await expect(approvalCardOf(page)).toHaveCount(0)
    await bobPage.context().close()
  })

  test('As a chat owner, my own write call runs without any approval card', { tag: ['@spec-33'] }, async ({
    page,
    agentScript,
  }) => {
    await agentScript(research, updateScript('Updated the record.'))
    await sendMessage(page, 'Alice updates the record')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await updateStepOf(page).click()
    await expect(messageItemsOf(page).filter({ hasText: 'ran update' })).not.toHaveCount(0)
    await expect(approvalCardOf(page)).toHaveCount(0)
  })

  test('As a chat owner, my Approve reads Approving… while it is sent, and when my other page denies first, the late Approve is refused and the card keeps Denied by Alice', {
    tag: ['@spec-35'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openAsBob(browser, workerStack)
    const secondAlicePage = await openPageAs(browser, workerStack, 'member-alice')
    await openChat(secondAlicePage, 'Research')
    await agentScript(research, updateScript('Alice did not approve the update.'))
    await sendMessage(bobPage, 'Bob asks to update the record')
    let sendAnswer = () => {}
    const isAnswerSent = new Promise<void>((resolve) => {
      sendAnswer = resolve
    })
    await page.route('**/api/chats/*/questions/*', async (route) => {
      await isAnswerSent
      await route.continue()
    })
    await approvalCardOf(page).getByRole('button', { name: 'Approve' }).click()
    await expect(approvalCardOf(page).getByRole('button', { name: 'Approving…' })).toBeDisabled()
    await expect(approvalCardOf(page).getByRole('button', { name: 'Deny' })).toBeDisabled()

    await approvalCardOf(secondAlicePage).getByRole('button', { name: 'Deny' }).click()
    await expect(approvalCardOf(page)).toContainText('Denied by Alice')
    const lateAnswer = page.waitForResponse('**/api/chats/*/questions/*')
    sendAnswer()
    expect((await lateAnswer).status()).toBe(409)
    await expect(workingIndicatorOf(bobPage)).toHaveCount(0)
    await expect(approvalCardOf(page)).toContainText('Denied by Alice')
    await expect(approvalCardOf(bobPage)).toContainText('Denied by Alice')
    await bobPage.context().close()
    await secondAlicePage.context().close()
  })
})
