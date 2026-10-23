import { expect, test } from 'bun:test'
import { createAgentTestbed, kindOf, piHello, questionAt, textOf } from './testing.ts'

const { stateDirectory, piLaunchOf, started } = createAgentTestbed()

test('a Pi turn over RPC streams thought and text, a command with its output and exit code and an edit diff, and ends the turn', async () => {
  const { open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  expect(socket.events).toEqual([])
  await prompt(id, 'stub:think stub:tools stub:terminal')
  await socket.until(kindOf('turn_end'))
  const [start] = socket.events
  expect(start?.update).toMatchObject({ sessionUpdate: 'session_started', resumeFailed: false })
  expect(String(start?.update.sessionId)).toEndWith('.json')
  expect(socket.events.filter(kindOf('agent_thought_chunk')).map(({ update }) => update.content)).toEqual([
    { type: 'text', text: 'Thinking ' },
    { type: 'text', text: 'about the plan.' },
  ])
  const finals = socket.events.filter((event) => kindOf('tool_call_update')(event) && event.completed)
  expect(finals.map(({ update }) => update)).toMatchObject([
    {
      toolCallId: 'edit-1',
      title: 'edit',
      kind: 'edit',
      status: 'completed',
      rawInput: { path: '/workspace/project/app.ts', edits: [{ oldText: 'one', newText: 'two' }] },
      content: [{ type: 'diff', path: '/workspace/project/app.ts', oldText: 'one', newText: 'two' }],
    },
    {
      toolCallId: 'command-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      rawOutput: { formatted_output: 'exit code 1', exit_code: 1 },
    },
    {
      toolCallId: 'terminal-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      rawOutput: { formatted_output: 'one\ntwo\nfailed', exit_code: 2 },
    },
  ])
  const live = socket.events.filter(
    (event) => kindOf('tool_call_update')(event) && !event.completed && event.update.toolCallId === 'terminal-1',
  )
  expect(live.map(({ update }) => update)).toEqual([
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'terminal-1',
      status: 'in_progress',
      rawOutput: { formatted_output: 'one\n' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'terminal-1',
      status: 'in_progress',
      rawOutput: { formatted_output: 'one\ntwo\n' },
    },
  ])
  expect(textOf(socket.events)).toBe(`[t1] permission:allow-always ${piHello(1).slice(5)}`)
  expect(socket.events.at(-1)?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
})

test('a Pi provider error ends the turn with an error update and the next prompt continues', async () => {
  const { open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:provider-error')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.slice(-2).map(({ update }) => update)).toEqual([
    { sessionUpdate: 'error', message: '529 overloaded' },
    { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
  ])
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.filter(kindOf('error'))).toHaveLength(1)
})

test('Stop aborts a Pi turn as cancelled and the next prompt continues the session', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:long')
  await socket.until((event) => event.update.toolCallId === 'long-1')
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(socket.events.findLast(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
  })
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events)).toBe(`[t1] ${piHello(2)}`)
  expect(socket.events.findLast(kindOf('turn_end'))?.update.stopReason).toBe('end_turn')
})

test('a new spyria-agent reopens a Pi session from its file with no replay, and a missing file falls back to a new session', async () => {
  const first = started()
  const id = await first.create(piLaunchOf())
  const socket = first.open(id)
  await first.prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  const sessionId = String(socket.events.find(kindOf('session_started'))?.update.sessionId)
  first.agent.stop()

  const second = started()
  const reopenedId = await second.create(piLaunchOf({ acp_resume_session_id: sessionId }))
  expect((await second.call('GET', `/api/conversations/${reopenedId}`)).body).toMatchObject({
    acp_session_id: sessionId,
    execution_status: 'idle',
  })
  const reopened = second.open(reopenedId)
  await second.prompt(reopenedId, 'hello again')
  await reopened.until(kindOf('turn_end'))
  expect(reopened.events[0]?.update).toMatchObject({ sessionUpdate: 'session_started', sessionId, resumeFailed: false })
  expect(reopened.events.filter(kindOf('agent_message_chunk')).length).toBeGreaterThan(0)
  expect(textOf(reopened.events)).toBe(piHello(2))

  const fallbackId = await second.create(piLaunchOf({ acp_resume_session_id: `${stateDirectory}/missing.json` }))
  const fallback = second.open(fallbackId)
  await second.prompt(fallbackId, 'hello')
  await fallback.until(kindOf('turn_end'))
  expect(fallback.events[0]?.update).toMatchObject({ sessionUpdate: 'session_started', resumeFailed: true })
  expect(fallback.events[0]?.update.sessionId).not.toBe(sessionId)
  expect(textOf(fallback.events)).toBe(piHello(1))
})

test('a Pi model switch sets the thinking level after Pi resets it, at launch and in place', async () => {
  const { call, open, create } = started()
  const valuesOf = (update: Record<string, unknown> | undefined) =>
    ['model', 'thought_level'].map(
      (optionId) =>
        ((update?.configOptions ?? []) as { id: string; currentValue: string }[]).find(({ id }) => id === optionId)
          ?.currentValue,
    )
  const id = await create(piLaunchOf({ acp_model: 'stub/stub-large', acp_thought_level: 'high' }))
  const socket = open(id)
  await socket.until(kindOf('config_option_update'))
  const [start] = socket.events
  expect(valuesOf(start?.update)).toEqual(['stub/stub-default', 'medium'])
  expect(start?.update.configOptions).toMatchObject([
    {
      category: 'model',
      options: [
        { value: 'stub/stub-default', name: 'Default (stub)' },
        { value: 'stub/stub-large', name: 'Large (stub)' },
      ],
    },
    { category: 'thought_level', options: ['off', 'low', 'medium', 'high'].map((value) => ({ value, name: value })) },
  ])
  expect(valuesOf(socket.events.findLast(kindOf('config_option_update'))?.update)).toEqual(['stub/stub-large', 'high'])

  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'stub/stub-default', thoughtLevel: 'low' })
  await socket.until(kindOf('config_option_update'), 2)
  expect(valuesOf(socket.events.findLast(kindOf('config_option_update'))?.update)).toEqual(['stub/stub-default', 'low'])

  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'stub/stub-large', thoughtLevel: 'ultra' })
  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'spyria/mistral/mistral-small-latest' })
  await socket.until(kindOf('config_option_update'), 4)
  const unlisted = socket.events.filter(kindOf('config_option_update')).slice(-2)
  expect(unlisted.map(({ update }) => valuesOf(update))).toEqual([
    ['stub/stub-large', 'off'],
    ['spyria/mistral/mistral-small-latest', 'off'],
  ])
})

test("a Pi question from the extension's select is one free question: a pick, and Other with a free answer through Pi's input", async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  const answerTo = (questionId: string, body: object) =>
    call('POST', `/api/conversations/${id}/questions/${questionId}`, body)

  await prompt(id, 'stub:ask')
  const questionId = await questionAt(socket, 1)
  const question = {
    questionId,
    toolCallId: 'ask-1',
    kind: 'question',
    questions: [
      {
        id: 'answer',
        text: 'Which database should we use?',
        options: [
          { value: 'Postgres', label: 'Postgres' },
          { value: 'SQLite', label: 'SQLite' },
        ],
        multi: false,
        free: true,
      },
    ],
  }
  expect(socket.events.find(kindOf('question'))?.update).toEqual({ sessionUpdate: 'question', ...question })
  expect((await answerTo(questionId, { approve: true })).status).toBe(400)
  expect((await answerTo(questionId, { answers: { answer: 'SQLite' } })).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(textOf(socket.events)).toBe(`[t1] answer:The member answered: SQLite ${piHello(1).slice(5)}`)
  expect(socket.events.find(kindOf('question_answered'))?.update).toEqual({
    sessionUpdate: 'question_answered',
    ...question,
    answers: { answer: 'SQLite' },
  })

  await prompt(id, 'stub:ask')
  expect((await answerTo(await questionAt(socket, 2), { answers: {}, free: { answer: 'MySQL' } })).status).toBe(200)
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events.slice(-6))).toContain('answer:The member answered: MySQL ')
  expect(socket.events.filter(kindOf('question'))).toHaveLength(2)

  await prompt(id, 'stub:ask')
  await answerTo(await questionAt(socket, 3), { answers: {} })
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events.slice(-6))).toContain('answer:The member did not answer. ')
})

test('Stop while a Pi question waits closes it as stopped and cancels the dialog; a sub-conversation answers Pi questions itself', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:ask')
  const questionId = await questionAt(socket, 1)
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(kindOf('question_closed'))?.update).toMatchObject({ questionId, reason: 'stopped' })
  expect(socket.events.findLast(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
  })
  expect(
    (await call('POST', `/api/conversations/${id}/questions/${questionId}`, { answers: { answer: 'SQLite' } })).status,
  ).toBe(409)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(2))

  const assumption = 'No member is available; decide yourself and state your assumption.'
  const sub = await create({ ...piLaunchOf(), parent_conversation_id: crypto.randomUUID() })
  const subSocket = open(sub)
  await prompt(sub, 'stub:ask')
  await subSocket.until(kindOf('turn_end'))
  expect(textOf(subSocket.events)).toContain(`answer:The member answered: ${assumption} `)
  expect(subSocket.events.filter(kindOf('question_answered')).map(({ update }) => update)).toMatchObject([
    { kind: 'question', answers: {}, free: { answer: assumption } },
  ])
  expect(subSocket.events.filter(kindOf('question'))).toEqual([])
})
