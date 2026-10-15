import {
  addCredential,
  expect,
  llmSectionOf,
  mainOf,
  messageItemsOf,
  newRuntimeChat,
  openChat,
  openProfile,
  type Page,
  sendMessage,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'
import { openPageAs, type WorkerStack } from './stack'

const claude = { owner: 'member-alice', signedIn: 'claude' }
const codex = { owner: 'member-alice', signedIn: 'codex' }
const assumption = 'No member is available; decide yourself and state your assumption.'

const chipOf = (page: Page) => mainOf(page).getByRole('button', { name: /^Claude Code · |^Codex · / })
const questionOf = (page: Page) => mainOf(page).getByRole('form', { name: 'Question' })
const planCardOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Plan approval' })
const modeOf = (page: Page, name: 'Plan' | 'Auto') =>
  mainOf(page).getByRole('group', { name: 'Mode' }).getByRole('radio', { name })
const repliesWith = (page: Page, text: string | RegExp) => messageItemsOf(page).filter({ hasText: text })
const turnEnded = async (page: Page) => {
  await expect(repliesWith(page, 'Hello from the stub')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
const newSession = async (page: Page, tool: 'Claude Code' | 'Codex', workerStack: WorkerStack) => {
  await expect
    .poll(
      async () =>
        (
          await workerStack.database.$client`
            select 1 from runtime_hosts where owner_id = 'member-alice' and status = 'online'
              and capacity->'signedIn' ? ${tool === 'Codex' ? 'codex' : 'claude'}`
        ).length,
    )
    .toBe(1)
  const chatId = await newRuntimeChat(page, `${tool} questions`, null)
  await expect(chipOf(page)).toHaveText(`${tool} · subscription`)
  return chatId
}
const sessionStarted = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(
      async () =>
        (
          await workerStack.database.$client`
            select 1 from runtimes where chat_id = ${chatId} and agent_conversation_id is not null`
        ).length,
    )
    .toBe(1)
const togglePlan = async (page: Page, isOn: boolean) => {
  await modeOf(page, isOn ? 'Plan' : 'Auto').click()
  await expect(modeOf(page, isOn ? 'Plan' : 'Auto')).toBeChecked()
  await expect(modeOf(page, isOn ? 'Auto' : 'Plan')).not.toBeChecked()
}
const holdAnswers = async (page: Page) => {
  const held = Promise.withResolvers<void>()
  await page.route('**/api/chats/*/questions/*', async (route) => {
    await held.promise
    await route.continue()
  })
  const response = page.waitForResponse((candidate) => candidate.url().includes('/questions/'))
  return async () => {
    held.resolve()
    return (await response).status()
  }
}

test.use({ runtimeHost: false })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('14a. a Claude Code question shows its header, options with descriptions and a free field; a pick reaches the agent and stays answered after a reload', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  const question = questionOf(page)
  await expect(question.getByRole('group', { name: 'Database Which database should we use?' })).toBeVisible()
  await expect(question.getByRole('radio')).toHaveCount(2)
  await expect(question.getByRole('radio', { name: 'Postgres Relational' })).toBeVisible()
  await expect(question.getByRole('textbox', { name: 'Other answer to Which database should we use?' })).toBeVisible()
  await question.getByRole('radio', { name: 'SQLite Embedded' }).check()
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(repliesWith(page, 'answer:{"action":"accept","content":{"question_0":"SQLite"}}')).toHaveCount(1)
  await turnEnded(page)
  await expect(question).toContainText('SQLite')
  await expect(question).toContainText('Answered by Alice')
  await expect(question.getByRole('button')).toHaveCount(0)

  await page.reload()
  await expect(questionOf(page)).toContainText('SQLite')
  await expect(questionOf(page)).toContainText('Answered by Alice')
  await expect(questionOf(page).getByRole('radio')).toHaveCount(0)
})

test('14e and 14b. a reload while the question waits shows the card again, and a free answer reaches the agent', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  await expect(questionOf(page).getByRole('radio')).toHaveCount(2)
  await page.reload()
  const question = questionOf(page)
  await expect(question.getByRole('radio')).toHaveCount(2)
  await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(repliesWith(page, '"question_0_custom":"MySQL"')).toHaveCount(1)
  await turnEnded(page)
  await expect(question).toContainText('MySQL')
})

test('14c. a Codex form of three questions shows on the same card, without its None of the above option', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(codex)
  await newSession(page, 'Codex', workerStack)
  await sendMessage(page, 'stub:ask-codex')
  const question = questionOf(page)
  await expect(question.getByRole('group')).toHaveCount(3)
  await expect(question.getByRole('group', { name: 'Database Which database should I use?' })).toBeVisible()
  await expect(question.getByRole('radio', { name: /None of the above/ })).toHaveCount(0)
  await question.getByRole('radio', { name: 'Postgres Relational' }).check()
  await question.getByRole('radio', { name: 'Go' }).check()
  await question.getByRole('textbox', { name: 'Other answer to Which CI?' }).fill('Buildkite')
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(
    repliesWith(
      page,
      'answer:{"action":"accept","content":{"db":"Postgres","lang":"Go","ci":"None of the above","ci_note":"Buildkite"}}',
    ),
  ).toHaveCount(1)
  await turnEnded(page)
})

test.describe('Pi on an HQ runtime chat', () => {
  test.use({ runtimeHost: true })
  const piChipOf = (page: Page) => mainOf(page).getByRole('button', { name: /· auto$/ })

  test('14c. a Pi select shows on the same card without its Other choice; a free answer reaches Pi through its input', async ({
    page,
  }) => {
    await newRuntimeChat(page, 'Pi questions')
    await sendMessage(page, 'stub:ask')
    const question = questionOf(page)
    await expect(question.getByRole('group', { name: 'Which database should we use?' })).toBeVisible()
    await expect(question.getByRole('radio')).toHaveCount(2)
    await expect(question.getByRole('radio', { name: /Other/ })).toHaveCount(0)
    await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(repliesWith(page, 'answer:The member answered: MySQL')).toHaveCount(1)
    await turnEnded(page)
    await expect(question).toContainText('MySQL')
    await expect(question).toContainText('Answered by Alice')
  })

  test('16a. the Plan toggle sets Pi’s plan mode on an HQ runtime chat and the toggle follows', async ({ page }) => {
    await newRuntimeChat(page, 'Pi plan mode')
    await sendMessage(page, 'stub:hello')
    await turnEnded(page)
    await togglePlan(page, true)
    await expect(piChipOf(page)).toHaveText(/· auto$/)
    await sendMessage(page, 'stub:hello')
    await expect(repliesWith(page, '[t2] Hello from the stub (model hq/fake/fake-medium, mode plan).')).toHaveCount(1)
    await togglePlan(page, false)
    await expect(piChipOf(page)).toHaveText(/· auto$/)
    await sendMessage(page, 'stub:hello')
    await expect(repliesWith(page, '[t3] Hello from the stub (model hq/fake/fake-medium, mode default).')).toHaveCount(
      1,
    )
  })
})

test('15. Stop while a question waits ends the turn Stopped, the card shows it, a late answer is refused, the next prompt works', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  const question = questionOf(page)
  await question.getByRole('radio', { name: 'SQLite Embedded' }).check()
  const releaseAnswer = await holdAnswers(page)
  await question.getByRole('button', { name: 'Submit' }).click()
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(repliesWith(page, 'Stopped by Alice')).toHaveCount(1)
  await expect(question).toContainText('Stopped')
  await expect(question.getByRole('button')).toHaveCount(0)
  expect(await releaseAnswer()).toBe(409)
  await sendMessage(page, 'Carry on')
  await expect(repliesWith(page, '[t2] Hello from the stub')).toHaveCount(1)
})

test('16a and 16b. the Plan toggle puts Claude Code in plan mode: the toggle shows Plan, a write is refused and a read runs; off again it builds', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await sessionStarted(workerStack, await newSession(page, 'Claude Code', workerStack))
  await togglePlan(page, true)
  await expect(chipOf(page)).toHaveText('Claude Code · subscription')
  await sendMessage(page, 'stub:write stub:read')
  await expect(repliesWith(page, 'write:reject')).toHaveCount(1)
  await expect(repliesWith(page, 'Read notes.md')).toHaveCount(1)
  await expect(repliesWith(page, 'mode plan).')).toHaveCount(1)
  await togglePlan(page, false)
  await sendMessage(page, 'Build')
  await expect(repliesWith(page, '[t2] Hello from the stub (model stub-default, mode bypassPermissions).')).toHaveCount(
    1,
  )
})

test('16a. the Plan toggle sets Codex’s collaboration mode and the toggle follows', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(codex)
  await sessionStarted(workerStack, await newSession(page, 'Codex', workerStack))
  await togglePlan(page, true)
  await expect(chipOf(page)).toHaveText('Codex · subscription')
  await togglePlan(page, false)
})

test('16c and 17a. the agent enters plan mode itself and the toggle follows; the plan card shows the plan; Approve continues the turn and leaves plan mode', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  const plan = planCardOf(page)
  await expect(plan.getByRole('listitem')).toHaveText(['Create x.txt', 'Done'])
  await expect(modeOf(page, 'Plan')).toBeChecked()
  await expect(mainOf(page)).not.toContainText('Approve Plan')
  await plan.getByRole('button', { name: 'Approve the plan' }).click()
  await expect(repliesWith(page, 'plan:exit-plan-bypass')).toHaveCount(1)
  await turnEnded(page)
  await expect(plan).toContainText('Approved by Alice')
  await expect(plan.getByRole('button')).toHaveCount(0)
  await expect(modeOf(page, 'Auto')).toBeChecked()
  await expect(mainOf(page)).not.toContainText('Approve Plan')
})

test('17b. Keep planning keeps Plan; the turn closes without Stopped and the next prompt is still in plan mode', async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  await planCardOf(page).getByRole('button', { name: 'Keep planning' }).click()
  await expect(repliesWith(page, 'plan:reject')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(planCardOf(page)).toContainText('Kept planning by Alice')
  await expect(mainOf(page)).not.toContainText('Stopped')
  await expect(modeOf(page, 'Plan')).toBeChecked()
  await sendMessage(page, 'Next')
  await expect(repliesWith(page, '[t2] Hello from the stub (model stub-default, mode plan).')).toHaveCount(1)
})

test('17c. Stop while the plan waits for approval closes the card', async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  await expect(planCardOf(page).getByRole('button', { name: 'Approve the plan' })).toBeVisible()
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(repliesWith(page, 'Stopped by Alice')).toHaveCount(1)
  await expect(planCardOf(page)).toContainText('Stopped')
  await expect(planCardOf(page).getByRole('button')).toHaveCount(0)
})

test.describe('on an HQ runtime chat', () => {
  test.use({ runtimeHost: true })

  test('14d. a viewer who cannot prompt sees the card read-only; another member who may prompt answers; a second answer is refused', async ({
    page,
    browser,
    workerStack,
  }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'stub:ask')
    await expect(questionOf(page).getByRole('button', { name: 'Submit' })).toBeVisible()

    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Research')
    const bobQuestion = questionOf(bobPage)
    await expect(bobQuestion.getByRole('radio', { name: 'SQLite', exact: true })).toBeDisabled()
    await expect(bobQuestion.getByRole('button')).toHaveCount(0)
    await expect(modeOf(bobPage, 'Plan')).toBeDisabled()
    await expect(modeOf(page, 'Plan')).toBeEnabled()

    await questionOf(page).getByRole('radio', { name: 'SQLite', exact: true }).check()
    const releaseAliceAnswer = await holdAnswers(page)
    await questionOf(page).getByRole('button', { name: 'Submit' }).click()

    await openProfile(bobPage)
    await addCredential(bobPage, { provider: 'OpenAI', secret: `fake-key-${crypto.randomUUID()}` })
    await expect(llmSectionOf(bobPage).getByRole('listitem').filter({ hasText: 'OpenAI' })).toBeVisible()
    await openChat(bobPage, 'Research')
    await bobQuestion.getByRole('radio', { name: 'Postgres', exact: true }).check()
    await bobQuestion.getByRole('button', { name: 'Submit' }).click()
    await expect(repliesWith(page, 'answer:The member answered: Postgres')).toHaveCount(1)
    await expect(questionOf(page)).toContainText('Answered by Bob')
    await expect(questionOf(page).getByRole('button')).toHaveCount(0)
    expect(await releaseAliceAnswer()).toBe(409)
    await bobPage.context().close()
  })

  test('28. a question in a delegated sub-conversation is declined with the assumption, shown in the delegation group', async ({
    page,
    agentScript,
    release,
  }) => {
    await openChat(page, 'Research')
    const answer = 'The subagent decided on its own.'
    const task = { task: 'stub:ask stub:linger', effort: 'small' }
    await agentScript('chat-research', {
      steps: [
        { tool: 'delegate', arguments: task },
        { tool: 'delegate', arguments: { ...task, resume: '$resume' }, hold: 'resume' },
      ],
      text: answer,
      delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
    })
    await sendMessage(page, 'Delegate a question')
    await release('resume')
    await release('linger')
    await expect(repliesWith(page, answer)).toHaveCount(1)
    await mainOf(page)
      .getByRole('button', { name: /^Delegated to Fake small · / })
      .click()
    const steps = page.getByRole('group', { name: 'Steps of Fake small' })
    await expect(steps.getByRole('form', { name: 'Question' })).toContainText(assumption)
    await expect(steps.getByRole('form', { name: 'Question' }).getByRole('button')).toHaveCount(0)
    await expect(messageItemsOf(page).filter({ has: steps })).toContainText(`answer:The member answered: ${assumption}`)
  })
})
