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

test('a Pi update_plan call is an ACP plan, not a step; a provider error ends the turn with an error update', async () => {
  const { open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:plan')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.filter(kindOf('plan')).map(({ update, completed }) => ({ update, completed }))).toEqual([
    {
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Write tests', status: 'completed', priority: 'medium' },
          { content: 'Fix the bug', status: 'in_progress', priority: 'medium' },
          { content: 'Ship', status: 'pending', priority: 'medium' },
        ],
      },
      completed: true,
    },
  ])
  expect(socket.events.filter((event) => String(event.update.sessionUpdate).startsWith('tool_call'))).toEqual([])

  await prompt(id, 'stub:provider-error')
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.slice(-2).map(({ update }) => update)).toEqual([
    { sessionUpdate: 'error', message: '529 overloaded' },
    { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
  ])
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
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
  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'hq/fake/fake-small' })
  await socket.until(kindOf('config_option_update'), 4)
  const unlisted = socket.events.filter(kindOf('config_option_update')).slice(-2)
  expect(unlisted.map(({ update }) => valuesOf(update))).toEqual([
    ['stub/stub-large', 'off'],
    ['hq/fake/fake-small', 'off'],
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

test("a Pi plan from the extension's confirm: keep planning and approve, the mode following the extension; the plan route switches it", async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  const modesOf = () => socket.events.filter(kindOf('current_mode_update')).map(({ update }) => update.currentModeId)
  const decide = async (approve: boolean, turns: number) => {
    const asked = socket.events.filter(kindOf('question')).length + 1
    await prompt(id, 'stub:exit-plan')
    const questionId = await questionAt(socket, asked)
    expect((await call('POST', `/api/conversations/${id}/questions/${questionId}`, { approve })).status).toBe(200)
    await socket.until(kindOf('turn_end'), turns)
    return socket.events.slice(socket.events.findLastIndex(kindOf('question')))
  }

  const kept = await decide(false, 1)
  expect(kept[0]?.update).toMatchObject({ kind: 'plan', toolCallId: 'exit-plan-1', plan: '1. Create x.txt\n2. Done' })
  expect(kept.find(kindOf('question_answered'))?.update).toMatchObject({ kind: 'plan', approved: false })
  expect(textOf(kept)).toBe(`plan:The member wants to keep planning. ${piHello(1, 'plan').slice(5)}`)
  expect(kept.find(kindOf('turn_end'))?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
  expect(modesOf()).toEqual(['plan'])

  const approved = await decide(true, 2)
  expect(textOf(approved)).toBe(
    `plan:The member approved the plan. Plan mode is off: carry it out. ${piHello(2).slice(5)}`,
  )
  expect(modesOf()).toEqual(['plan', 'default'])

  expect((await call('POST', `/api/conversations/${id}/plan_mode`, { enabled: true })).status).toBe(200)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(3, 'plan'))
  expect((await call('POST', `/api/conversations/${id}/plan_mode`, { enabled: false })).status).toBe(200)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 4)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(4))
  expect(modesOf()).toEqual(['plan', 'default', 'plan', 'default'])
  expect(socket.events.filter(kindOf('current_mode_update')).every((event) => event.completed)).toBe(true)
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
  await prompt(sub, 'stub:exit-plan')
  await subSocket.until(kindOf('turn_end'), 2)
  expect(textOf(subSocket.events)).toContain(`answer:The member answered: ${assumption} `)
  expect(textOf(subSocket.events)).toContain('plan:The member approved the plan.')
  expect(subSocket.events.filter(kindOf('question_answered')).map(({ update }) => update)).toMatchObject([
    { kind: 'question', answers: {}, free: { answer: assumption } },
    { kind: 'plan', approved: true },
  ])
  expect(subSocket.events.filter(kindOf('question'))).toEqual([])
})
