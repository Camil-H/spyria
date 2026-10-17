import {
  addLlmKey,
  addParticipant,
  expect,
  messageItemsOf,
  openChat,
  type Page,
  research,
  sendMessage,
  test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const updateScript = (text: string) => ({
  steps: [{ tool: 'crm-update', arguments: { text: 'Renewal on 1 May' } }],
  text,
})
const approvalCardOf = (page: Page) => messageItemsOf(page).getByRole('region', { name: 'Tool approval' })
const updateStepOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: 'Used update (crm)' })

const openAsBob = async (browser: Parameters<typeof openPageAs>[0], workerStack: WorkerStack) => {
  await addParticipant(workerStack, research, 'member-bob', 'prompter')
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake')
  await openChat(bobPage, 'Research')
  return bobPage
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Research')
})

test('2. a guest’s write call waits for the owner’s approval; once approved it runs and the reply continues', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
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

test('3. when the owner denies, the agent gets the refusal and says so; the card reads Denied by Alice', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
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

test('4. a guest’s read-only call runs without approval', async ({ page, browser, workerStack, agentScript }) => {
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

test('5. the owner’s own write call runs without any approval card', async ({ page, agentScript }) => {
  await agentScript(research, updateScript('Updated the record.'))
  await sendMessage(page, 'Alice updates the record')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await updateStepOf(page).click()
  await expect(messageItemsOf(page).filter({ hasText: 'ran update' })).not.toHaveCount(0)
  await expect(approvalCardOf(page)).toHaveCount(0)
})

test('35-2. Approve reads Approving… while it is sent; when another page denies first, the late Approve is refused and the card keeps Denied by Alice', async ({
  page,
  browser,
  workerStack,
  agentScript,
}) => {
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
