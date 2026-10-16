import {
  addLlmKey,
  delegationsFinished,
  expect,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openSession,
  type Page,
  sendMessage,
  sessionOf,
  test,
} from './fixtures'
import { openPageAs } from './stack'

const researchChatId = 'chat-research'
const confidentSmall = { tier: 'small', confidence: 'high', effort: 'low' }
const subagentWork = { steps: [{ command: 'echo listing' }, { command: 'echo done' }], text: 'Two files.' }
const delegating = (answer: string, script: object) => ({
  steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } }],
  text: answer,
  ...script,
})

const groupOf = (page: Page, modelName: string) =>
  mainOf(page).getByRole('button', { name: new RegExp(`^Delegated to ${modelName} · 2 steps · `) })
const promptAndWait = async (page: Page, text: string, answer: string) => {
  await sendMessage(page, text)
  await expect(messageItemsOf(page).filter({ hasText: answer })).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await openChat(page, 'Research')
})

test('5 and 13. a small task is delegated to a Pi sub-conversation on the small model, shown as one collapsed group before the answer, which is the sub’s final message', async ({
  page,
  agentScript,
}) => {
  const answer = 'The subagent listed the files.'
  const work = {
    ...subagentWork,
    steps: [{ command: 'echo listing', say: 'Let me list them.' }, { command: 'echo done' }],
  }
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': work } }),
  )
  await promptAndWait(page, 'Delegate the listing', answer)
  const group = groupOf(page, 'Fake small')
  await expect(group).toBeVisible()
  await expect(messageItemsOf(page).last()).toContainText(answer)
  await expect(mainOf(page)).not.toContainText('$ echo listing')
  await group.click()
  const steps = page.getByRole('group', { name: 'Steps of Fake small' })
  await expect(steps).toContainText('$ echo listing')
  await expect(steps).toContainText('$ echo done')
  await expect(messageItemsOf(page).filter({ has: steps })).toContainText('Two files.')
})

test('6. with the policy on Same as main, the subagent runs on the session model without a routing call', async ({
  page,
  agentScript,
}) => {
  const answer = 'Done on the same model.'
  await openSession(page)
  await sessionOf(page).getByLabel('Subagents').selectOption({ label: 'Same as main' })
  await page.keyboard.press('Escape')
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-medium': subagentWork } }),
  )
  await promptAndWait(page, 'Delegate on the same model', answer)
  await expect(groupOf(page, 'Fake medium')).toBeVisible()
})

const delegatingTo = (model: string, answer: string, script: object) => ({
  steps: [{ tool: 'delegate', arguments: { task: 'List the project files', effort: 'small', model } }],
  text: answer,
  ...script,
})
const resuming = (answer: string, script: object, resumeHold?: string) => ({
  steps: [
    { tool: 'delegate', arguments: { task: 'List the project files', effort: 'small' } },
    {
      tool: 'delegate',
      arguments: { task: 'List the project files', effort: 'small', resume: '$resume' },
      hold: resumeHold,
    },
  ],
  text: answer,
  ...script,
})
test('8. Bob asks for fake-large and gets fake-small, with the fallback line on the group', async ({
  browser,
  workerStack,
  agentScript,
}) => {
  const bobPage = await openPageAs(browser, workerStack, 'member-bob')
  await addLlmKey(bobPage, 'Fake-small')
  const bobChatId = await newRuntimeChat(bobPage, 'Bob delegates')
  const answer = 'Listed on what Bob can reach.'
  await agentScript(bobChatId, delegatingTo('fake-large', answer, { subagents: { 'fake-small': subagentWork } }))
  await promptAndWait(bobPage, 'Use fake-large to list the files', answer)
  await expect(groupOf(bobPage, 'Fake small')).toBeVisible()
  await expect(mainOf(bobPage)).toContainText("Fake large isn't reachable with Bob's keys; used Fake small")
  await bobPage.context().close()
})

test('10. a subagent failure answers with HQ’s error, the group shows failed, and the main agent goes on', async ({
  page,
  agentScript,
}) => {
  const answer = 'The subagent failed, I will do it myself.'
  const failing = { steps: [{ command: 'echo listing' }, { fail: 'Overloaded' }] }
  await agentScript(
    researchChatId,
    delegating(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': failing } }),
  )
  await promptAndWait(page, 'Delegate a failing listing', answer)
  const group = mainOf(page).getByRole('button', { name: /^Delegated to Fake small · failed · / })
  await expect(group).toBeVisible()
  await expect(mainOf(page)).not.toContainText('The agent stopped with an error')
  await group.click()
  const steps = page.getByRole('group', { name: 'Steps of Fake small' })
  await expect(messageItemsOf(page).filter({ has: steps })).toContainText(
    'The subagent on Fake small stopped with an error',
  )
})

test('11 and f-3. a long subagent task returns still running and reads as still delegating, then its result on resume, in one group with one answer', async ({
  page,
  agentScript,
  release,
  reached,
  workerStack,
}) => {
  const answer = 'The long listing is done.'
  const heldWork = { ...subagentWork, text: 'The slow listing found two files today.', hold: 'subagent' }
  await agentScript(
    researchChatId,
    resuming(answer, { delegateRoute: confidentSmall, subagents: { 'fake-small': heldWork } }, 'resume'),
  )
  await sendMessage(page, 'Delegate a long listing')
  await reached('resume')
  await expect(mainOf(page).getByRole('button', { name: /^Delegating to Fake small/ })).toBeVisible()
  await expect(mainOf(page)).not.toContainText(/timed out|failed/)
  await release('subagent')
  await delegationsFinished(workerStack, researchChatId)
  await release('resume')
  await expect(messageItemsOf(page).filter({ hasText: answer })).toBeVisible()
  await expect(groupOf(page, 'Fake small')).toHaveCount(1)
  await expect(mainOf(page).getByRole('button', { name: /^Used delegate/ })).toHaveCount(0)
  await groupOf(page, 'Fake small').click()
  const group = messageItemsOf(page).filter({ has: page.getByRole('group', { name: 'Steps of Fake small' }) })
  await expect(group).toContainText('The slow listing found two files today.')
  await expect(group).not.toContainText('is still running')
  await expect(messageItemsOf(page).filter({ hasText: answer })).toHaveCount(1)
})

test('12. stopping during a delegation stops the subagent, the group shows stopped, and the next prompt runs', async ({
  page,
  agentScript,
}) => {
  const longWork = {
    steps: [{ command: 'echo listing' }],
    text: 'one two three four five six seven eight nine ten',
    hold: 'subagent',
  }
  await agentScript(
    researchChatId,
    resuming('Never shown.', { delegateRoute: confidentSmall, subagents: { 'fake-small': longWork } }),
  )
  await sendMessage(page, 'Delegate a very long listing')
  await expect(mainOf(page).getByRole('button', { name: /^Delegating to Fake small/ })).toBeVisible()
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(mainOf(page).getByRole('button', { name: /^Delegated to Fake small · stopped · 1 step/ })).toBeVisible()
  await expect(messageItemsOf(page).filter({ hasText: 'Stopped by Alice' })).toHaveCount(1)
  await agentScript(researchChatId, { text: 'Back to work.' })
  await promptAndWait(page, 'Carry on', 'Back to work.')
  await expect(mainOf(page)).not.toContainText('Never shown.')
})
