import { openPageAs } from '../stack'
import {
  addCredential,
  addParticipant,
  delegationsFinished,
  expect,
  forEachHarness,
  holdAnswers,
  type Locator,
  llmSectionOf,
  mainOf,
  messageContaining,
  messageItemsOf,
  newHarnessChat,
  openChat,
  openProfile,
  type Page,
  questionOf,
  sendMessage,
  machineTest as test,
  turnEnded,
} from './fixtures'

const assumption = 'No member is available; decide yourself and state your assumption.'

const askPromptOf = { Pi: 'stub:ask', 'Claude Code': 'stub:ask', Codex: 'stub:ask-codex' }

const radioCountOf = { Pi: 2, 'Claude Code': 2, Codex: 6 }

const answerWithChoice = {
  Pi: async (page: Page, question: Locator) => {
    await expect(question.getByRole('group', { name: 'Which database should we use?' })).toBeVisible()
    await expect(question.getByRole('radio')).toHaveCount(2)
    await expect(question.getByRole('radio', { name: /Other/ })).toHaveCount(0)
    await question.getByRole('radio', { name: 'SQLite', exact: true }).check()
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, 'answer:The member answered: SQLite')).toHaveCount(1)
    return 'SQLite'
  },
  'Claude Code': async (page: Page, question: Locator) => {
    await expect(question.getByRole('group', { name: 'Database Which database should we use?' })).toBeVisible()
    await expect(question.getByRole('radio')).toHaveCount(2)
    await expect(question.getByRole('radio', { name: 'Postgres Relational' })).toBeVisible()
    await expect(question.getByRole('textbox', { name: 'Other answer to Which database should we use?' })).toBeVisible()
    await question.getByRole('radio', { name: 'SQLite Embedded' }).check()
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, 'answer:{"action":"accept","content":{"question_0":"SQLite"}}')).toHaveCount(1)
    return 'SQLite'
  },
  Codex: async (page: Page, question: Locator) => {
    await expect(question.getByRole('group')).toHaveCount(3)
    await expect(question.getByRole('group', { name: 'Database Which database should I use?' })).toBeVisible()
    await expect(question.getByRole('radio', { name: /None of the above/ })).toHaveCount(0)
    await question.getByRole('radio', { name: 'SQLite File' }).check()
    await question.getByRole('radio', { name: 'TypeScript' }).check()
    await question.getByRole('radio', { name: 'GitHub Actions' }).check()
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(
      messageContaining(
        page,
        'answer:{"action":"accept","content":{"db":"SQLite","lang":"TypeScript","ci":"GitHub Actions"}}',
      ),
    ).toHaveCount(1)
    return 'SQLite'
  },
}

const answerInFreeText = {
  Pi: async (page: Page, question: Locator) => {
    await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, 'answer:The member answered: MySQL')).toHaveCount(1)
    return 'MySQL'
  },
  'Claude Code': async (page: Page, question: Locator) => {
    await question.getByRole('textbox', { name: 'Other answer to Which database should we use?' }).fill('MySQL')
    await question.getByRole('button', { name: 'Submit' }).click()
    await expect(messageContaining(page, '"question_0_custom":"MySQL"')).toHaveCount(1)
    return 'MySQL'
  },
  Codex: async (page: Page, question: Locator) => {
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
    return 'Buildkite'
  },
}

const pickAnyChoice = {
  Pi: (question: Locator) => question.getByRole('radio', { name: 'SQLite', exact: true }).check(),
  'Claude Code': (question: Locator) => question.getByRole('radio', { name: 'SQLite Embedded' }).check(),
  Codex: async (question: Locator) => {
    await question.getByRole('radio', { name: 'Postgres Relational' }).check()
    await question.getByRole('radio', { name: 'Go' }).check()
    await question.getByRole('radio', { name: 'GitHub Actions' }).check()
  },
}

test.describe('Questions', () => {
  test.use({ runtimeHost: false })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  forEachHarness((harness) => {
    const tags = { tag: ['@spec-25', ...(harness.name === 'Claude Code' ? ['@smoke'] : [])] }

    test(
      `As a prompter, I answer the agent’s question with a choice, and the card stays answered after a reload [${harness.name}]`,
      tags,
      async ({ page, machine, workerStack }) => {
        await newHarnessChat(page, harness, `${harness.name} asks`, { machine, workerStack })
        await sendMessage(page, askPromptOf[harness.name])
        const question = questionOf(page)
        const shownAnswer = await answerWithChoice[harness.name](page, question)
        await turnEnded(page)
        await expect(question).toContainText(shownAnswer)
        await expect(question).toContainText('Answered by Alice')
        await expect(question.getByRole('button')).toHaveCount(0)

        await page.reload()
        await expect(questionOf(page)).toContainText(shownAnswer)
        await expect(questionOf(page)).toContainText('Answered by Alice')
        await expect(questionOf(page).getByRole('radio')).toHaveCount(0)
      },
    )

    test(`As a prompter, I reload while the question waits, see the card again and answer in free text [${harness.name}]`, {
      tag: ['@spec-25'],
    }, async ({ page, machine, workerStack }) => {
      await newHarnessChat(page, harness, `${harness.name} free answer`, { machine, workerStack })
      await sendMessage(page, askPromptOf[harness.name])
      await expect(questionOf(page).getByRole('radio')).toHaveCount(radioCountOf[harness.name])
      await page.reload()
      const question = questionOf(page)
      await expect(question.getByRole('radio')).toHaveCount(radioCountOf[harness.name])
      const shownAnswer = await answerInFreeText[harness.name](page, question)
      await turnEnded(page)
      await expect(question).toContainText(shownAnswer)
      await expect(question).toContainText('Answered by Alice')
    })

    test(`As a prompter, I stop while a question waits: the turn ends Stopped, the card shows it, a late answer is refused and the next prompt works [${harness.name}]`, {
      tag: ['@spec-25'],
    }, async ({ page, machine, workerStack }) => {
      await newHarnessChat(page, harness, `${harness.name} stops a question`, { machine, workerStack })
      await sendMessage(page, askPromptOf[harness.name])
      const question = questionOf(page)
      await pickAnyChoice[harness.name](question)
      const releaseAnswer = await holdAnswers(page)
      await question.getByRole('button', { name: 'Submit' }).click()
      await mainOf(page).getByRole('button', { name: 'Stop' }).click()
      await expect(messageContaining(page, 'Stopped by Alice')).toHaveCount(1)
      await expect(question).toContainText('Stopped')
      await expect(question.getByRole('button')).toHaveCount(0)
      expect(await releaseAnswer()).toBe(409)
      await sendMessage(page, 'stub:hello Carry on')
      await expect(messageContaining(page, '[t2] Hello from the stub')).toHaveCount(1)
    })
  })

  test.describe(() => {
    test.use({ runtimeHost: true })

    test('As a viewer who cannot prompt, I see the question read-only, while another member who may prompt answers it and a second answer is refused', {
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

    test('As a prompter, I see a question asked in a delegated sub-conversation declined with the assumption, inside the delegation group', {
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
        .getByRole('button', { name: /^Delegated to Mistral Small · / })
        .click()
      const steps = page.getByRole('group', { name: 'Steps of Mistral Small' })
      await expect(steps.getByRole('form', { name: 'Question' })).toContainText(assumption)
      await expect(steps.getByRole('form', { name: 'Question' }).getByRole('button')).toHaveCount(0)
      await expect(messageItemsOf(page).filter({ has: steps })).toContainText(
        `answer:The member answered: ${assumption}`,
      )
    })
  })
})
