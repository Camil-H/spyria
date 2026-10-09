import { expect, mainOf, messageItemsOf, openChat, type Page, sendMessage, test } from './fixtures'

const agentReply = { timeout: 90_000 }
const metered = { timeout: 30_000 }
const researchChatId = 'chat-research'
const summary = 'Summary of the earlier listings.'
const condensedNotice = 'Context condensed · earlier steps summarized'
const longListing = (count: number, from: number) =>
  Array.from({ length: count }, (_, index) => ({
    command: `seq ${(from + index) * 1000} ${(from + index) * 1000 + 500}`,
  }))
type GatewayLog = { metadata: Record<string, string> }

const promptAndWait = async (page: Page, text: string, answer: string) => {
  await sendMessage(page, text)
  await expect(messageItemsOf(page).filter({ hasText: answer })).toBeVisible(agentReply)
}

test.describe('real Agent Server', () => {
  test.use({ agentServer: 'real' })
  test.describe.configure({ mode: 'default' })

  test('1. a long session condenses with a divider, the next prompt is answered, and Usage counts the condenser call on the prompter', async ({
    page,
    workerStack,
    agentScript,
  }) => {
    test.setTimeout(300_000)
    const startedAt = new Date()
    await page.goto('/')
    await openChat(page, 'Research')
    await agentScript(researchChatId, { steps: longListing(12, 1), text: 'First listing done.', summary })
    await promptAndWait(page, 'List the first ranges', 'First listing done.')
    await expect(messageItemsOf(page).filter({ hasText: condensedNotice })).toHaveCount(0)
    await agentScript(researchChatId, { steps: longListing(12, 20), text: 'Second listing done.', summary })
    await promptAndWait(page, 'List more ranges', 'Second listing done.')
    await expect(messageItemsOf(page).filter({ hasText: condensedNotice })).toHaveCount(1)
    await agentScript(researchChatId, { text: 'Third answer after condensing.' })
    await promptAndWait(page, 'What did you list?', 'Third answer after condensing.')

    const logsOf = async (role?: string) =>
      (
        (
          await workerStack.gateway<{ logs: GatewayLog[] | null }>(
            `/api/logs?metadata_chat=${researchChatId}&metadata_database=${workerStack.databaseName}&start_time=${startedAt.toISOString()}${role ? `&metadata_role=${role}` : ''}&limit=200`,
          )
        ).logs ?? []
      ).filter((log) => !role || log.metadata.role === role)
    await expect.poll(async () => (await logsOf('condenser')).length, metered).toBeGreaterThanOrEqual(1)
    for (const log of await logsOf('condenser')) expect(log.metadata.prompter).toBe('member-alice')
    const allCalls = (await logsOf()).length
    await page.getByRole('region', { name: 'Side panel' }).getByRole('tab', { name: 'Usage', exact: true }).click()
    const aliceRow = page
      .getByRole('region', { name: 'Side panel' })
      .getByRole('tabpanel')
      .getByRole('table')
      .getByRole('row', { name: /^Alice\b/ })
    await expect(aliceRow.getByRole('cell').nth(2)).toHaveText(String(allCalls), metered)
    await expect(mainOf(page)).toContainText('Third answer after condensing.')
  })
})
