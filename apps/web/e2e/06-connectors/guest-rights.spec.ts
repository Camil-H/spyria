import { openPageAs } from '../stack'
import {
  accountOf,
  approvalsOf,
  chooseConnectionAction,
  connectFake,
  expect,
  lastToolResultOf,
  messageItemsOf,
  openChat,
  openProfile,
  openPrompterWithKey,
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
const updateStepOf = (page: Page) => messageItemsOf(page).getByRole('button', { name: 'Used update (CRM)' })
const sharingNoteOf = (page: Page) =>
  page.getByRole('note').filter({ hasText: 'everyone in this chat sees what they return' })

test.describe('Guest rights', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await openChat(page, 'Research')
  })

  test('As a prompter in someone’s chat, my prompts use my own account on a server each member signs in to, never the owner’s: unconnected, only I get the Connect link', {
    tag: ['@spec-33', '@smoke'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const account = accountOf('alice-acme')
    await connectFake(page, account)
    const bobPage = await openPrompterWithKey(browser, workerStack, research)
    await test.step('warns me before my first prompt that everyone here sees what my tools return', async () => {
      await expect(sharingNoteOf(bobPage)).toBeVisible()
    })

    await promptTool(bobPage, agentScript, 'Bob asks who the agent is', {
      ...toolScript,
      text: 'You need to connect fake first.',
    })
    await test.step('names me to connect, with the link for me only', async () => {
      await expect(await lastToolResultOf(bobPage)).toContainText('Bob needs to connect fake')
      await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Connect fake' })).toBeVisible()
      await openChat(page, 'Research')
      await expect(messageItemsOf(page).getByText('Bob needs to connect fake').first()).toBeVisible()
      await expect(messageItemsOf(page).getByRole('button', { name: 'Connect fake' })).toHaveCount(0)
      await expect(sharingNoteOf(bobPage)).toHaveCount(0)
    })

    await test.step('the owner’s own prompt uses the owner’s account', async () => {
      await promptTool(page, agentScript, 'Alice asks who the agent is')
      await expect(await lastToolResultOf(page)).toContainText(`you are ${account}`)
    })
    await bobPage.context().close()
  })

  test('As a guest, my write call waits for the owner’s approval, and once approved it runs and the reply continues', {
    tag: ['@spec-33'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openPrompterWithKey(browser, workerStack, research)
    await agentScript(research, updateScript('Updated the record.'))
    await sendMessage(bobPage, 'Bob asks to update the record')
    await expect(approvalCardOf(page)).toContainText("The agent asks to run update (CRM) on Bob's prompt")
    await expect(approvalCardOf(page)).toContainText('{"text":"Renewal on 1 May"}')
    await expect(approvalCardOf(bobPage)).toContainText("Waiting for Alice's approval")
    await expect(approvalCardOf(bobPage).getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(messageItemsOf(bobPage).getByRole('button', { name: 'Waiting to use update (CRM)' })).toBeVisible()
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
    const bobPage = await openPrompterWithKey(browser, workerStack, research)
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

  test('As a chat owner, I set CRM’s update to Always in my approvals, and my own prompt waits for my approval before it runs', {
    tag: ['@spec-58'],
  }, async ({ page, agentScript }) => {
    await openProfile(page, 'Connections')
    await chooseConnectionAction(page, 'CRM', 'Approvals')
    const updateApproval = approvalsOf(page, 'CRM').getByRole('combobox', { name: 'Approval for update' })
    await expect(updateApproval.locator('option:checked')).toHaveText("Default (On a guest's prompt)")
    await updateApproval.selectOption('always')
    await expect(updateApproval).toHaveValue('always')
    await approvalsOf(page, 'CRM').getByRole('button', { name: 'Done' }).click()

    await openChat(page, 'Research')
    await agentScript(research, updateScript('Updated the record.'))
    await sendMessage(page, 'Alice updates the record')
    await expect(approvalCardOf(page)).toContainText("The agent asks to run update (CRM) on Alice's prompt")
    await approvalCardOf(page).getByRole('button', { name: 'Approve' }).click()
    await expect(approvalCardOf(page)).toContainText('Approved by Alice')
    await expect(workingIndicatorOf(page)).toHaveCount(0)
    await updateStepOf(page).click()
    await expect(messageItemsOf(page).filter({ hasText: 'ran update' })).not.toHaveCount(0)
  })

  test('As a chat owner, my Approve reads Approving… while it is sent, and when my other page denies first, the late Approve is refused and the card keeps Denied by Alice', {
    tag: ['@spec-35'],
  }, async ({ page, browser, workerStack, agentScript }) => {
    const bobPage = await openPrompterWithKey(browser, workerStack, research)
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
