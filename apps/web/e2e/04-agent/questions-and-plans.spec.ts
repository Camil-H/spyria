import { openPageAs, type WorkerStack } from '../stack'
import {
  addCredential,
  addParticipant,
  chipOf,
  delegationsFinished,
  expect,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  modeRadioOf,
  newRuntimeChat,
  newSession,
  openChat,
  openProfile,
  type Page,
  panelOf,
  sendMessage,
  sessionStarted,
  machineTest as test,
  workingIndicatorOf,
} from './fixtures'

const claude = { owner: 'member-alice', signedIn: 'claude' }
const codex = { owner: 'member-alice', signedIn: 'codex' }
const assumption = 'No member is available; decide yourself and state your assumption.'

const questionOf = (page: Page) => mainOf(page).getByRole('form', { name: 'Question' })
const planCardOf = (page: Page) => mainOf(page).getByRole('region', { name: 'Plan approval' })
const turnEnded = async (page: Page) => {
  await expect(messageContaining(page, 'Hello from the stub')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
}
const newOnlineSession = async (page: Page, tool: 'Claude Code' | 'Codex', workerStack: WorkerStack) => {
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
  return newSession(page, tool, `${tool} questions`)
}
const togglePlan = async (page: Page, isOn: boolean) => {
  await modeRadioOf(page, isOn ? 'Plan' : 'Auto').click()
  await expect(modeRadioOf(page, isOn ? 'Plan' : 'Auto')).toBeChecked()
  await expect(modeRadioOf(page, isOn ? 'Auto' : 'Plan')).not.toBeChecked()
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

test('a Claude Code question shows its header, options with descriptions and a free field; a pick reaches the agent and stays answered after a reload', {
  tag: ['@spec-25', '@smoke'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  const question = questionOf(page)
  await expect(question.getByRole('group', { name: 'Database Which database should we use?' })).toBeVisible()
  await expect(question.getByRole('radio')).toHaveCount(2)
  await expect(question.getByRole('radio', { name: 'Postgres Relational' })).toBeVisible()
  await expect(question.getByRole('textbox', { name: 'Other answer to Which database should we use?' })).toBeVisible()
  await question.getByRole('radio', { name: 'SQLite Embedded' }).check()
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(messageContaining(page, 'answer:{"action":"accept","content":{"question_0":"SQLite"}}')).toHaveCount(1)
  await turnEnded(page)
  await expect(question).toContainText('SQLite')
  await expect(question).toContainText('Answered by Alice')
  await expect(question.getByRole('button')).toHaveCount(0)

  await page.reload()
  await expect(questionOf(page)).toContainText('SQLite')
  await expect(questionOf(page)).toContainText('Answered by Alice')
  await expect(questionOf(page).getByRole('radio')).toHaveCount(0)
})

test('a reload while the question waits shows the card again, and a free answer reaches the agent', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  await expect(questionOf(page).getByRole('radio')).toHaveCount(2)
  await page.reload()
  const question = questionOf(page)
  await expect(question.getByRole('radio')).toHaveCount(2)
  await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(messageContaining(page, '"question_0_custom":"MySQL"')).toHaveCount(1)
  await turnEnded(page)
  await expect(question).toContainText('MySQL')
})

test('a Codex form of three questions shows on the same card, without its None of the above option', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(codex)
  await newOnlineSession(page, 'Codex', workerStack)
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
    messageContaining(
      page,
      'answer:{"action":"accept","content":{"db":"Postgres","lang":"Go","ci":"None of the above","ci_note":"Buildkite"}}',
    ),
  ).toHaveCount(1)
  await turnEnded(page)
})

test.describe('Pi on an HQ runtime chat', () => {
  test.use({ runtimeHost: true })

  test('a Pi select shows on the same card without its Other choice; a free answer reaches Pi through its input', {
    tag: ['@spec-25'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Pi questions')
    await sendMessage(page, 'stub:ask')
    const question = questionOf(page)
    await expect(question.getByRole('group', { name: 'Which database should we use?' })).toBeVisible()
    await expect(question.getByRole('radio')).toHaveCount(2)
    await expect(question.getByRole('radio', { name: /Other/ })).toHaveCount(0)
    await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, 'answer:The member answered: MySQL')).toHaveCount(1)
    await turnEnded(page)
    await expect(question).toContainText('MySQL')
    await expect(question).toContainText('Answered by Alice')
  })

  test('the Plan toggle sets Pi’s plan mode on an HQ runtime chat and the toggle follows', {
    tag: ['@spec-25'],
  }, async ({ page }) => {
    await newRuntimeChat(page, 'Pi plan mode')
    await sendMessage(page, 'stub:hello')
    await turnEnded(page)
    await togglePlan(page, true)
    await expect(chipOf(page, 'hq')).toBeVisible()
    await sendMessage(page, 'stub:hello')
    await expect(
      messageContaining(page, '[t2] Hello from the stub (model hq/fake/fake-medium, mode plan).'),
    ).toHaveCount(1)
    await togglePlan(page, false)
    await expect(chipOf(page, 'hq')).toBeVisible()
    await sendMessage(page, 'stub:hello')
    await expect(
      messageContaining(page, '[t3] Hello from the stub (model hq/fake/fake-medium, mode default).'),
    ).toHaveCount(1)
  })
})

test('Stop while a question waits ends the turn Stopped, the card shows it, a late answer is refused, the next prompt works', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:ask')
  const question = questionOf(page)
  await question.getByRole('radio', { name: 'SQLite Embedded' }).check()
  const releaseAnswer = await holdAnswers(page)
  await question.getByRole('button', { name: 'Submit' }).click()
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)
  await expect(question).toContainText('Stopped')
  await expect(question.getByRole('button')).toHaveCount(0)
  expect(await releaseAnswer()).toBe(409)
  await sendMessage(page, 'Carry on')
  await expect(messageContaining(page, '[t2] Hello from the stub')).toHaveCount(1)
})

test('the Plan toggle puts Claude Code in plan mode: the toggle shows Plan, a write is refused and a read runs; off again it builds', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await sessionStarted(workerStack, await newOnlineSession(page, 'Claude Code', workerStack))
  await togglePlan(page, true)
  await expect(chipOf(page, 'harness')).toHaveText('Claude Code · subscription')
  await sendMessage(page, 'stub:write stub:read')
  await expect(messageContaining(page, 'write:reject')).toHaveCount(1)
  await expect(messageContaining(page, 'Read notes.md')).toHaveCount(1)
  await expect(messageContaining(page, 'mode plan).')).toHaveCount(1)
  await togglePlan(page, false)
  await sendMessage(page, 'Build')
  await expect(
    messageContaining(page, '[t2] Hello from the stub (model stub-default, mode bypassPermissions).'),
  ).toHaveCount(1)
})

test('the Plan toggle sets Codex’s collaboration mode and the toggle follows', { tag: ['@spec-25'] }, async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(codex)
  await sessionStarted(workerStack, await newOnlineSession(page, 'Codex', workerStack))
  await togglePlan(page, true)
  await expect(chipOf(page, 'harness')).toHaveText('Codex · subscription')
  await togglePlan(page, false)
})

test('the agent enters plan mode itself and the toggle follows; the plan card shows the plan; Approve continues the turn and leaves plan mode', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  const plan = planCardOf(page)
  await expect(plan.getByRole('listitem')).toHaveText(['Create x.txt', 'Done'])
  await expect(modeRadioOf(page, 'Plan')).toBeChecked()
  await expect(mainOf(page)).not.toContainText('Approve Plan')
  await plan.getByRole('button', { name: 'Approve the plan' }).click()
  await expect(messageContaining(page, 'plan:exit-plan-bypass')).toHaveCount(1)
  await turnEnded(page)
  await expect(plan).toContainText('Approved by Alice')
  await expect(plan.getByRole('button')).toHaveCount(0)
  await expect(modeRadioOf(page, 'Auto')).toBeChecked()
  await expect(mainOf(page)).not.toContainText('Approve Plan')
})

test('an approved plan shows as Markdown in the Plan tab until a newer checklist replaces it', {
  tag: ['@spec-25', '@stage-f'],
}, async ({ page, machine, workerStack }) => {
  const openPlanTab = () => panelOf(page).getByRole('tab', { name: 'Plan', exact: true }).click()
  const planTab = panelOf(page).getByRole('tabpanel')
  const approvedPlan = planTab.getByRole('region', { name: 'Approved plan' })
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  await expect(planCardOf(page).getByRole('button', { name: 'Approve the plan' })).toBeVisible()
  await openPlanTab()
  await expect(planTab).toHaveText(/^PlanNo planA plan the agent writes in plan mode shows here\.$/)
  await planCardOf(page).getByRole('button', { name: 'Approve the plan' }).click()
  await turnEnded(page)
  await expect(approvedPlan.getByRole('listitem')).toHaveText(['Create x.txt', 'Done'])
  await page.reload()
  await openPlanTab()
  await expect(approvedPlan.getByRole('listitem')).toHaveText(['Create x.txt', 'Done'])

  await sendMessage(page, 'stub:plan-progress')
  await expect(mainOf(page).getByRole('group', { name: 'Plan' })).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(approvedPlan).toHaveCount(0)
  await expect(planTab.getByRole('listitem')).toHaveCount(2)
  await expect(planTab).toContainText('Fix the totals')
})

test('Keep planning keeps Plan; the turn closes without Stopped and the next prompt is still in plan mode', {
  tag: ['@spec-25'],
}, async ({ page, machine, workerStack }) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  await planCardOf(page).getByRole('button', { name: 'Keep planning' }).click()
  await expect(messageContaining(page, 'plan:reject')).toHaveCount(1)
  await expect(workingIndicatorOf(page)).toHaveCount(0)
  await expect(planCardOf(page)).toContainText('Kept planning by Alice')
  await expect(mainOf(page)).not.toContainText('Stopped')
  await expect(modeRadioOf(page, 'Plan')).toBeChecked()
  await sendMessage(page, 'Next')
  await expect(messageContaining(page, '[t2] Hello from the stub (model stub-default, mode plan).')).toHaveCount(1)
})

test('Stop while the plan waits for approval closes the card', { tag: ['@spec-25'] }, async ({
  page,
  machine,
  workerStack,
}) => {
  await machine(claude)
  await newOnlineSession(page, 'Claude Code', workerStack)
  await sendMessage(page, 'stub:exit-plan')
  await expect(planCardOf(page).getByRole('button', { name: 'Approve the plan' })).toBeVisible()
  await mainOf(page).getByRole('button', { name: 'Stop' }).click()
  await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)
  await expect(planCardOf(page)).toContainText('Stopped')
  await expect(planCardOf(page).getByRole('button')).toHaveCount(0)
})

test.describe('on an HQ runtime chat', () => {
  test.use({ runtimeHost: true })

  test('a viewer who cannot prompt sees the card read-only; another member who may prompt answers; a second answer is refused', {
    tag: ['@spec-25'],
  }, async ({ page, browser, workerStack }) => {
    await openChat(page, 'Research')
    await sendMessage(page, 'stub:ask')
    await expect(questionOf(page).getByRole('button', { name: 'Submit' })).toBeVisible()

    await addParticipant(workerStack, 'chat-research', 'member-bob', 'prompter')
    const bobPage = await openPageAs(browser, workerStack, 'member-bob')
    await openChat(bobPage, 'Research')
    const bobQuestion = questionOf(bobPage)
    await expect(bobQuestion.getByRole('radio', { name: 'SQLite', exact: true })).toBeDisabled()
    await expect(bobQuestion.getByRole('button')).toHaveCount(0)
    await expect(modeRadioOf(bobPage, 'Plan')).toBeDisabled()
    await expect(modeRadioOf(page, 'Plan')).toBeEnabled()

    await questionOf(page).getByRole('radio', { name: 'SQLite', exact: true }).check()
    const releaseAliceAnswer = await holdAnswers(page)
    await questionOf(page).getByRole('button', { name: 'Submit' }).click()

    await openProfile(bobPage)
    await addCredential(bobPage, { provider: 'OpenAI', secret: `fake-key-${crypto.randomUUID()}` })
    await expect(llmSectionOf(bobPage).getByRole('listitem').filter({ hasText: 'OpenAI' })).toBeVisible()
    await openChat(bobPage, 'Research')
    await bobQuestion.getByRole('radio', { name: 'Postgres', exact: true }).check()
    await bobQuestion.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, 'answer:The member answered: Postgres')).toHaveCount(1)
    await expect(questionOf(page)).toContainText('Answered by Bob')
    await expect(questionOf(page).getByRole('button')).toHaveCount(0)
    expect(await releaseAliceAnswer()).toBe(409)
    await bobPage.context().close()
  })

  test('a question in a delegated sub-conversation is declined with the assumption, shown in the delegation group', {
    tag: ['@spec-25'],
  }, async ({ page, agentScript, release, reached, workerStack }) => {
    await openChat(page, 'Research')
    const answer = 'The subagent decided on its own.'
    const task = { task: 'stub:ask stub:linger', effort: 'small' }
    await agentScript('chat-research', {
      steps: [
        { tool: 'delegate', arguments: task },
        { tool: 'await_task', arguments: { taskId: '$taskId' }, hold: 'resume' },
      ],
      text: answer,
      delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
    })
    await sendMessage(page, 'Delegate a question')
    await reached('resume')
    await release('linger')
    await delegationsFinished(workerStack, 'chat-research')
    await release('resume')
    await expect(messageContaining(page, answer)).toHaveCount(1)
    await mainOf(page)
      .getByRole('button', { name: /^Delegated to Fake small · / })
      .click()
    const steps = page.getByRole('group', { name: 'Steps of Fake small' })
    await expect(steps.getByRole('form', { name: 'Question' })).toContainText(assumption)
    await expect(steps.getByRole('form', { name: 'Question' }).getByRole('button')).toHaveCount(0)
    await expect(messageItemsOf(page).filter({ has: steps })).toContainText(`answer:The member answered: ${assumption}`)
  })
})
