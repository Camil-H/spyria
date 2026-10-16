import {
  chipOf,
  composerOf,
  expect,
  type Locator,
  mainOf,
  messageContaining,
  messageItemsOf,
  modeOf,
  modeRadioOf,
  newRuntimeChat,
  type Page,
  panelOf,
  sendMessage,
  sessionOf,
  sessionStarted,
  test,
  workingIndicatorOf,
} from './fixtures'

const workingDirectoryOf = (page: Page) =>
  mainOf(page).getByRole('img', { name: 'Working directory' }).locator('xpath=..')
const branchOf = (page: Page) => mainOf(page).getByRole('img', { name: 'Git branch' }).locator('xpath=..')
const turnsEnded = async (page: Page, count: number) => {
  await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(count)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('The element has no box')
  return { top: box.y, bottom: box.y + box.height, middle: box.y + box.height / 2 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('e1, e4, g-1 and g-2. the working directory sits above the text box; Runs on, the model and Plan/Auto sit in the bar under it; Plan/Auto waits for the session with its reason in the tooltip and no Starting… text; the model chip shows model and effort only, the subagent policy stays in the session dialog', async ({
  page,
}) => {
  await newRuntimeChat(page, 'Composer layout')
  await expect(modeRadioOf(page, 'Plan')).toBeDisabled()
  await expect(modeRadioOf(page, 'Auto')).toBeDisabled()
  await expect(modeOf(page)).toHaveAttribute('title', 'Plan and Auto are available once the agent session has started')
  await expect(modeOf(page)).toHaveText('PlanAuto')
  await expect(workingDirectoryOf(page)).toHaveCount(0)

  await sendMessage(page, 'stub:hello')
  await turnsEnded(page, 1)
  await expect(modeRadioOf(page, 'Plan')).toBeEnabled()
  await expect(modeRadioOf(page, 'Auto')).toBeChecked()
  await expect(modeOf(page)).not.toHaveAttribute('title')
  await expect(modeOf(page)).toHaveText('PlanAuto')
  await expect(chipOf(page, 'hq')).toHaveText(/^Fake medium( \((low|medium|high)\))?$/)
  await chipOf(page, 'hq').click()
  await expect(sessionOf(page).getByLabel('Subagents')).toHaveValue('auto')
  await page.keyboard.press('Escape')
  await expect(workingDirectoryOf(page)).toHaveText(/^workspace-\d+$/)
  await expect(workingDirectoryOf(page)).toHaveAttribute('title', /\/workspace-\d+$/)

  const textBox = await boxOf(composerOf(page))
  const runsOn = await boxOf(mainOf(page).getByRole('combobox', { name: 'Runs on' }))
  const model = await boxOf(chipOf(page, 'hq'))
  const mode = await boxOf(modeOf(page))
  expect((await boxOf(workingDirectoryOf(page))).bottom).toBeLessThanOrEqual(textBox.top)
  for (const control of [runsOn, model, mode]) {
    expect(control.top).toBeGreaterThanOrEqual(textBox.bottom)
    expect(Math.abs(control.middle - runsOn.middle)).toBeLessThan(4)
  }
})

test('e2. without git there is no branch chip; once the agent switches to a branch it shows, and both chips come back after a reload', async ({
  page,
}) => {
  await newRuntimeChat(page, 'Branch chip')
  await sendMessage(page, 'stub:hello')
  await turnsEnded(page, 1)
  await expect(workingDirectoryOf(page)).toBeVisible()
  await expect(branchOf(page)).toHaveCount(0)

  await sendMessage(page, 'stub:branch feature/composer')
  await turnsEnded(page, 2)
  await expect(branchOf(page)).toHaveText('feature/composer')

  await page.reload()
  await expect(branchOf(page)).toHaveText('feature/composer')
  await expect(workingDirectoryOf(page)).toHaveText(/^workspace-\d+$/)
  await expect(modeRadioOf(page, 'Plan')).toBeEnabled()
})

test('e5. a Pi chat whose agent calls update_plan shows the checklist in the chat and the Plan panel, with no tool step', async ({
  page,
  workerStack,
  agentScript,
}) => {
  const chatId = await newRuntimeChat(page, 'Pi plan')
  const plan = [
    { content: 'Reproduce the bug', status: 'completed' },
    { content: 'Fix the totals', status: 'in_progress' },
    { content: 'Ship', status: 'pending' },
  ]
  await agentScript(chatId, { steps: [{ plan }], text: 'Planned the fix.' })
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
  await panelOf(page).getByRole('tab', { name: 'Plan', exact: true }).click()
  await expect(panelOf(page).getByRole('tabpanel').getByRole('listitem')).toHaveCount(3)
  await expect(panelOf(page).getByRole('tabpanel')).toContainText('Fix the totals')
})

test('e6. a Pi turn hitting a provider error shows the relay’s notice once; an error the relay did not see shows Pi’s own message', async ({
  page,
  agentScript,
}) => {
  const chatId = await newRuntimeChat(page, 'Pi errors')
  await agentScript(chatId, { steps: [{ fail: 'The model is overloaded' }] })
  await sendMessage(page, 'Try anyway')
  const errors = messageItemsOf(page).getByRole('alert')
  await expect(errors).toHaveCount(1)
  await expect(errors).toContainText('The provider is unavailable, try again shortly')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(mainOf(page)).not.toContainText('The agent stopped with an error')

  await sendMessage(page, 'stub:provider-error')
  await expect(errors).toHaveCount(2)
  await expect(errors.nth(1)).toContainText('529 overloaded')
  await expect(workingIndicatorOf(page)).toHaveCount(0)
})
