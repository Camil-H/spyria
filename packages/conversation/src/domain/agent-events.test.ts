import { expect, test } from 'bun:test'
import {
  type AgentEvent,
  agentNotices,
  agentProjectionOf,
  executionStatusOf,
  isPlanningOf,
  isStoredAgentEvent,
  notReadyNoticeOf,
  reopenedTurnOutcomeOf,
  startFailureNoticeOf,
  streamedTextOf,
  subagentDelegationOf,
  toolCallIdOf,
  turnEndNoticeOf,
  waitingNotices,
} from './agent-events.ts'
import claudeCodeToolCalls from './claude-code-tool-calls.fixture.json'
import { messagesFromEvents } from './message-events.ts'
import { type StreamedReply, storedStreamedReply, streamedReplyAfter, visibleStreamedReply } from './streamed-reply.ts'
import { acpUpdate } from './testing.ts'

test('a turn ends with a notice on error, or when it finished without any reply', () => {
  expect(turnEndNoticeOf('finished', true)).toBeUndefined()
  expect(turnEndNoticeOf('finished', false)).toBe(agentNotices.noReply)
  expect(turnEndNoticeOf('error', true)).toBe(agentNotices.stoppedWithError)
  expect(turnEndNoticeOf('error', false)).toBe(agentNotices.stoppedWithError)
})

test('a runtime that cannot be placed reads as no host, any other failure as could not start', () => {
  expect(agentNotices.couldNotStart).toBe('The agent could not start')
  expect(startFailureNoticeOf('no_host')).toBe(agentNotices.noHost)
  expect(startFailureNoticeOf('no_capacity')).toBe(agentNotices.noHost)
  expect(startFailureNoticeOf('no_image')).toBe("Spyria's runtime image is not built: run bun run agent:build")
  for (const failure of ['create_failed', 'start_failed', 'lost'])
    expect(startFailureNoticeOf(failure)).toBe(agentNotices.couldNotStart)
})

test('a local session waiting on its unplaced or offline machine reads as your machine is offline, and waits', () => {
  expect(notReadyNoticeOf({ state: 'host_offline' }, true)).toBe('Your machine is offline')
  expect(notReadyNoticeOf({ state: 'failed', failure: 'no_host' }, true)).toBe('Your machine is offline')
  expect(notReadyNoticeOf({ state: 'failed', failure: 'create_failed' }, true)).toBe(agentNotices.couldNotStart)
  expect(notReadyNoticeOf({ state: 'host_offline' }, false)).toBe(agentNotices.hostOffline)
  expect(notReadyNoticeOf({ state: 'failed', failure: 'no_host' }, false)).toBe(agentNotices.noHost)
  expect(waitingNotices).toContain(agentNotices.machineOffline)
})

const repliesOf =
  (counts: Record<string, number>) =>
  (promptId: string): number =>
    counts[promptId] ?? 0

test('deltas of one prompt append to the streamed reply until a stored reply of that prompt arrives', () => {
  let streamed: StreamedReply = null
  streamed = streamedReplyAfter(streamed, { promptId: 'first', text: 'Understood, ' }, repliesOf({}))
  streamed = streamedReplyAfter(streamed, { promptId: 'first', text: 'working' }, repliesOf({}))
  expect(visibleStreamedReply(streamed, repliesOf({}))).toMatchObject({
    promptId: 'first',
    text: 'Understood, working',
  })
  expect(visibleStreamedReply(streamed, repliesOf({ first: 1 }))).toBeNull()
  expect(visibleStreamedReply(streamed, repliesOf({ other: 1 }))).not.toBeNull()
})

test('a delta after a stored reply, or for another prompt, starts a new streamed reply', () => {
  const afterToolCall = streamedReplyAfter(
    { promptId: 'first', text: 'Running it.', repliesAtStart: 0 },
    { promptId: 'first', text: 'Done' },
    repliesOf({ first: 1 }),
  )
  expect(afterToolCall).toEqual({ promptId: 'first', text: 'Done', repliesAtStart: 1 })
  expect(visibleStreamedReply(afterToolCall, repliesOf({ first: 1 }))?.text).toBe('Done')
  expect(
    streamedReplyAfter(afterToolCall, { promptId: 'second', text: 'Understood, ' }, repliesOf({ first: 2 })),
  ).toEqual({ promptId: 'second', text: 'Understood, ', repliesAtStart: 0 })
})

test('a stored frame hides a delta that reached the browser after its stored reply, and the next delta starts afresh', () => {
  const streamed = streamedReplyAfter(null, { promptId: 'first', text: 'Understood, working on ' }, repliesOf({}))
  const late = streamedReplyAfter(streamed, { promptId: 'first', text: 'it.' }, repliesOf({ first: 1 }))
  expect(visibleStreamedReply(late, repliesOf({ first: 1 }))?.text).toBe('it.')
  const isAnswer = (messageId: string) => messageId === 'answer'
  const lateStored = storedStreamedReply(late, { promptId: 'first', storedId: 'answer' })
  expect(visibleStreamedReply(lateStored, repliesOf({ first: 1 }), isAnswer)).toBeNull()

  const stored = storedStreamedReply(streamed, { promptId: 'first', storedId: 'answer' })
  expect(visibleStreamedReply(stored, repliesOf({}), () => false)?.text).toBe('Understood, working on ')
  expect(visibleStreamedReply(stored, repliesOf({ first: 1 }), isAnswer)).toBeNull()
  expect(streamedReplyAfter(stored, { promptId: 'first', text: 'Next' }, repliesOf({})).text).toBe('Next')
  expect(storedStreamedReply(stored, { promptId: 'second', storedId: 'other' })).toBe(stored)
})

test('a snapshot frame replaces the streamed text, and an empty stream shows nothing', () => {
  const resumed = streamedReplyAfter(
    { promptId: 'first', text: 'stale', repliesAtStart: 0 },
    { promptId: 'first', text: 'Understood, working ', isSnapshot: true },
    repliesOf({}),
  )
  expect(resumed.text).toBe('Understood, working ')
  expect(visibleStreamedReply(null, repliesOf({}))).toBeNull()
  expect(visibleStreamedReply({ promptId: 'first', text: '', repliesAtStart: 0 }, repliesOf({}))).toBeNull()
})

test('reasoning frames stream as reasoning, and the answer text after them starts afresh', () => {
  const reasoning = streamedReplyAfter(null, { promptId: 'first', text: 'Weighing', isReasoning: true }, repliesOf({}))
  expect(streamedReplyAfter(reasoning, { promptId: 'first', text: ' it', isReasoning: true }, repliesOf({}))).toEqual({
    promptId: 'first',
    text: 'Weighing it',
    repliesAtStart: 0,
    isReasoning: true,
  })
  expect(streamedReplyAfter(reasoning, { promptId: 'first', text: 'Answer' }, repliesOf({}))).toEqual({
    promptId: 'first',
    text: 'Answer',
    repliesAtStart: 0,
  })
})

const storedEventsOf = (entries: readonly { event: AgentEvent; delegation?: object }[]) =>
  entries.map(({ event, delegation }, index) => ({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: event.id,
    seq: index + 1,
    type: 'agent.event',
    actor: null,
    payload: { replyToId: 'prompt-1', event, ...(delegation && { delegation }) },
    createdAt: new Date(Date.parse('2026-10-12T17:56:00Z') + index * 1000),
  }))
const toolCallUpdate = (seq: number, toolCallId: string, status: string, fields: Record<string, unknown>) =>
  acpUpdate(seq, {
    sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update',
    toolCallId,
    status,
    rawInput: {},
    ...fields,
  })

test('Claude Code edits, reads and Spyria tools get their step types, a subagent’s calls keep their ids inside its group, and its messages stay out of the chat', () => {
  const subagent = { id: 'conversation-1:toolu_task', model: '', modelName: '', task: '' }
  const diff = [{ type: 'diff', path: '/workspace/project/notes.md', oldText: null, newText: 'one\ntwo\n' }]
  const write = { title: 'Write notes.md', kind: 'edit', content: diff }
  const mcp = { title: 'mcp__spyria__fake-whoami', kind: 'other' }
  const stored = storedEventsOf([
    { event: toolCallUpdate(1, 'toolu_write', 'pending', write), delegation: subagent },
    { event: toolCallUpdate(2, 'toolu_write', 'completed', write), delegation: subagent },
    { event: acpUpdate(6, { sessionUpdate: 'agent_message', text: 'Subagent notes' }), delegation: subagent },
    {
      event: toolCallUpdate(3, 'toolu_read', 'pending', {
        title: 'Read notes.md',
        kind: 'read',
        rawInput: { file_path: '/workspace/project/notes.md' },
      }),
    },
    { event: toolCallUpdate(4, 'toolu_mcp', 'pending', mcp) },
    { event: toolCallUpdate(5, 'toolu_mcp', 'completed', { ...mcp, rawOutput: 'you are bob' }) },
  ])
  expect(messagesFromEvents(stored).map(({ id, step }) => ({ id, step }))).toEqual([
    {
      id: 'conversation-1:toolu_write',
      step: {
        type: 'file',
        operation: 'create',
        path: 'notes.md',
        added: 2,
        removed: 0,
        diff: [
          { kind: 'added', text: 'one' },
          { kind: 'added', text: 'two' },
        ],
        delegation: subagent,
      },
    },
    {
      id: 'conversation-1:toolu_read',
      step: { type: 'file', operation: 'read', path: 'notes.md', added: 0, removed: 0, diff: [] },
    },
    {
      id: 'conversation-1:toolu_mcp',
      step: { type: 'tool', name: 'whoami (fake)', arguments: '{}', result: 'you are bob' },
    },
  ])
})

test('a Codex command and a Spyria tool call start in progress and finish with Codex’s output shapes', () => {
  const command = { title: 'echo hello', kind: 'execute', rawInput: { command: 'echo hello' } }
  const mcp = {
    title: 'mcp.spyria.fake-whoami',
    kind: 'execute',
    rawInput: { server: 'spyria', tool: 'fake-whoami', arguments: { verbose: true } },
  }
  const stored = storedEventsOf([
    { event: toolCallUpdate(1, 'call_command', 'in_progress', command) },
    {
      event: toolCallUpdate(2, 'call_command', 'completed', {
        ...command,
        rawOutput: { formatted_output: 'hello\n', exit_code: 0 },
      }),
    },
    { event: toolCallUpdate(3, 'call_mcp', 'in_progress', mcp) },
    {
      event: toolCallUpdate(4, 'call_mcp', 'completed', {
        ...mcp,
        rawOutput: { result: { content: [{ type: 'text', text: 'you are bob' }] }, error: null },
      }),
    },
  ])
  expect(messagesFromEvents(stored).map(({ id, step }) => ({ id, step }))).toEqual([
    {
      id: 'conversation-1:call_command',
      step: {
        type: 'command',
        command: 'echo hello',
        exitCode: 0,
        durationMilliseconds: 1000,
        output: 'hello\n',
        truncatedLines: 0,
      },
    },
    {
      id: 'conversation-1:call_mcp',
      step: { type: 'tool', name: 'whoami (fake)', arguments: '{"verbose":true}', result: 'you are bob' },
    },
  ])
})

test('a real Claude Code sequence of pending then completed or failed calls ends with the final titles and inputs, every step done', () => {
  const steps = messagesFromEvents(storedEventsOf(claudeCodeToolCalls.map((event) => ({ event })))).map(
    ({ id, step }) => ({ id, step }),
  )
  expect(steps).toMatchObject([
    {
      id: 'conversation-1:toolu_01BawE7ZV28RVEVNShsEA3Uj',
      step: {
        type: 'command',
        command: 'ls -la /workspace/project && git -C /workspace/project log --oneline -5 2>&1 | head -20',
        exitCode: 0,
        output: expect.stringContaining('total 0'),
      },
    },
    {
      id: 'conversation-1:toolu_01Uietr3ZHknr6fdX1vUGHgR',
      step: {
        type: 'command',
        command: expect.stringMatching(/^cat \/workspace\/project\/CLAUDE\.md/),
        exitCode: 1,
        output: 'Exit code 1',
      },
    },
    {
      id: 'conversation-1:toolu_01V5JoN21hHzqnuw2hL9qAoH',
      step: { type: 'command', command: expect.stringMatching(/^which python3 node npx/), exitCode: 0 },
    },
    {
      id: 'conversation-1:toolu_01MNfMCpA947uCwubk6pYiyY',
      step: { type: 'tool', name: 'Skill dataviz', arguments: '', result: 'Launching skill: dataviz' },
    },
    {
      id: 'conversation-1:toolu_01NfP88BRpnXgBEEvbHgVRvJ',
      step: {
        type: 'file',
        operation: 'read',
        path: '/tmp/claude-10001/bundled-skills/2.1.220/4fd2f3caa0d4a7094ca0b32256511d63/dataviz/references/palette.md',
      },
    },
  ])
  expect(steps).toHaveLength(5)
  for (const { step } of steps) expect(JSON.stringify(step)).not.toContain('"exitCode":null')
})

test('a Skill call is titled with its skill from the final event, with its args and no raw input', () => {
  const skillCall = (seq: number, status: string, rawInput: object) =>
    toolCallUpdate(seq, 'toolu_skill', status, { title: 'Skill', kind: 'other', rawInput })
  const [skillStep] = messagesFromEvents(
    storedEventsOf([
      { event: skillCall(1, 'pending', {}) },
      { event: skillCall(2, 'completed', { skill: 'dataviz', args: 'a bar chart of sales' }) },
    ]),
  )
  expect(skillStep?.step).toMatchObject({ type: 'tool', name: 'Skill dataviz', arguments: 'a bar chart of sales' })
  expect(JSON.stringify(skillStep?.step)).not.toContain('"skill"')
})

test('a spyria-agent sequence projects text, a thought with its duration, steps merged by their final call, and a turn end', () => {
  const diff = { type: 'diff', path: '/workspace/project/app.ts', oldText: 'one', newText: 'two' }
  const edit = {
    toolCallId: 'edit-1',
    title: 'Edit app.ts',
    kind: 'edit',
    rawInput: { file_path: '/workspace/project/app.ts' },
  }
  const messages = messagesFromEvents(
    storedEventsOf(
      [
        acpUpdate(1, { sessionUpdate: 'session_started', sessionId: 's1', resumeFailed: false }),
        acpUpdate(2, { sessionUpdate: 'agent_thought', text: 'Plan it.', durationMilliseconds: 1500 }),
        acpUpdate(3, { sessionUpdate: 'tool_call', ...edit, title: 'Edit', status: 'pending', rawInput: {} }, false),
        acpUpdate(4, { sessionUpdate: 'tool_call_update', ...edit, status: 'completed', content: [diff] }),
        acpUpdate(5, { sessionUpdate: 'agent_message', text: 'Done.' }),
        acpUpdate(6, { sessionUpdate: 'turn_end', stopReason: 'end_turn' }),
      ].map((event) => ({ event })),
    ),
  )
  expect(messages.map(({ id, kind, body, step }) => ({ id, kind, body, step }))).toMatchObject([
    { id: 'conversation-1:2', kind: 'step', step: { type: 'thought', text: 'Plan it.', durationMilliseconds: 1500 } },
    {
      id: 'conversation-1:edit-1',
      kind: 'step',
      step: { type: 'file', operation: 'edit', path: 'app.ts', added: 1, removed: 1 },
    },
    { id: 'conversation-1:5', kind: 'agent', body: 'Done.' },
  ])
})

test('Pi’s read, write and edit calls carry their path in rawInput.path, and a write creates the file', () => {
  const stepOf = (title: string, kind: string, rawInput: Record<string, unknown>) =>
    agentProjectionOf(acpUpdate(3, { sessionUpdate: 'tool_call', toolCallId: 't', title, kind, rawInput }))
  const path = '/workspace/project/notes.md'
  expect(stepOf('read', 'read', { path })).toMatchObject({
    step: { type: 'file', operation: 'read', path: 'notes.md' },
  })
  expect(stepOf('write', 'edit', { path, content: 'one' })).toMatchObject({
    step: { type: 'file', operation: 'create', path: 'notes.md' },
  })
  expect(stepOf('edit', 'edit', { path, oldText: 'one', newText: 'two' })).toMatchObject({
    step: { type: 'file', operation: 'edit', path: 'notes.md' },
  })
})

test('a spyria-agent turn ends finished or in error, a cancelled turn end ends nothing, and a failed resume says so', () => {
  const turnEnd = (stopReason: string) => agentProjectionOf(acpUpdate(9, { sessionUpdate: 'turn_end', stopReason }))
  expect(turnEnd('end_turn')).toEqual({ type: 'turn-end', outcome: 'finished' })
  expect(turnEnd('error')).toEqual({ type: 'turn-end', outcome: 'error' })
  expect(turnEnd('cancelled')).toBeUndefined()
  expect(agentProjectionOf(acpUpdate(1, { sessionUpdate: 'session_started', resumeFailed: true }))).toEqual({
    type: 'message',
    body: agentNotices.newSession,
    kind: 'notice',
  })
  expect(agentProjectionOf(acpUpdate(1, { sessionUpdate: 'session_started', resumeFailed: false }))).toBeUndefined()
  expect(agentProjectionOf(acpUpdate(2, { sessionUpdate: 'error', message: 'Authentication required' }))).toEqual({
    type: 'step',
    step: { type: 'error', message: 'Authentication required' },
  })
})

test('spyria-agent chunks stream and are never stored, while completed items and tool calls are', () => {
  const chunk = (sessionUpdate: string, text: string) =>
    acpUpdate(3, { sessionUpdate, content: { type: 'text', text } }, false)
  expect(streamedTextOf(chunk('agent_message_chunk', 'Hi'))).toEqual({ text: 'Hi', isReasoning: false })
  expect(streamedTextOf(chunk('agent_thought_chunk', 'Hm'))).toEqual({ text: 'Hm', isReasoning: true })
  expect(streamedTextOf(acpUpdate(4, { sessionUpdate: 'turn_end' }))).toBeUndefined()
  const isStored = (update: Record<string, unknown>, completed: boolean) =>
    isStoredAgentEvent(acpUpdate(5, update, completed))
  expect(isStored({ sessionUpdate: 'agent_message_chunk' }, false)).toBe(false)
  expect(isStored({ sessionUpdate: 'tool_call' }, false)).toBe(true)
  expect(isStored({ sessionUpdate: 'tool_call_update' }, false)).toBe(false)
  expect(isStored({ sessionUpdate: 'tool_call_update' }, true)).toBe(true)
  expect(isStored({ sessionUpdate: 'turn_end' }, true)).toBe(true)
  expect(isStored({ sessionUpdate: 'plan' }, true)).toBe(true)
})

test('answered and closed questions are stored as one question step each, live questions are not, and a kept plan ends the turn', () => {
  const question = {
    questionId: 'q1',
    toolCallId: 'ask-1',
    kind: 'question' as const,
    questions: [{ id: 'question_0', text: 'Which?', options: [], multi: false, free: true }],
  }
  expect(isStoredAgentEvent(acpUpdate(1, { sessionUpdate: 'question', ...question }, false))).toBe(false)
  const answered = acpUpdate(2, { sessionUpdate: 'question_answered', ...question, answers: {}, answeredBy: 'm1' })
  const closed = acpUpdate(3, { sessionUpdate: 'question_closed', kind: 'plan', questionId: 'q2', reason: 'stopped' })
  expect([answered, closed].every(isStoredAgentEvent)).toBe(true)
  expect(agentProjectionOf(answered)).toEqual({
    type: 'step',
    step: { type: 'question', ...question, answers: {}, answeredBy: 'm1' },
  })
  expect(agentProjectionOf(closed)).toEqual({
    type: 'step',
    step: { type: 'question', kind: 'plan', questionId: 'q2', closed: 'stopped' },
  })
  expect(
    agentProjectionOf(acpUpdate(4, { sessionUpdate: 'turn_end', stopReason: 'cancelled', keptPlanning: true })),
  ).toEqual({ type: 'turn-end', outcome: 'finished' })
})

test('plan mode follows the mode update, the mode or collaboration mode option, and a new session', () => {
  const planningOf = (update: Record<string, unknown>) => isPlanningOf(acpUpdate(1, update))
  const options = (mode: string, collaboration?: string) => [
    { id: 'mode', category: 'mode', currentValue: mode },
    { id: 'model', category: 'model', currentValue: 'm' },
    ...(collaboration ? [{ id: 'collaboration_mode', currentValue: collaboration }] : []),
  ]
  expect(planningOf({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toBe(true)
  expect(planningOf({ sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' })).toBe(false)
  expect(planningOf({ sessionUpdate: 'config_option_update', configOptions: options('plan') })).toBe(true)
  expect(planningOf({ sessionUpdate: 'config_option_update', configOptions: options('agent', 'plan') })).toBe(true)
  expect(planningOf({ sessionUpdate: 'config_option_update', configOptions: options('agent', 'default') })).toBe(false)
  expect(planningOf({ sessionUpdate: 'config_option_update', configOptions: [{ category: 'model' }] })).toBeUndefined()
  expect(planningOf({ sessionUpdate: 'session_started', configOptions: [] })).toBe(false)
  expect(planningOf({ sessionUpdate: 'turn_end' })).toBeUndefined()
  expect(isStoredAgentEvent(acpUpdate(1, { sessionUpdate: 'current_mode_update' }))).toBe(true)
})

test('a spyria-agent plan update becomes a plan step with its entries mapped to Spyria statuses', () => {
  const entries = [
    { content: 'Write tests', status: 'completed', priority: 'high' },
    { content: 'Fix the bug', status: 'in_progress', priority: 'medium' },
    { content: 'Ship', status: 'pending', priority: 'low' },
  ]
  expect(agentProjectionOf(acpUpdate(2, { sessionUpdate: 'plan', entries }))).toEqual({
    type: 'step',
    step: {
      type: 'plan',
      items: [
        { title: 'Write tests', status: 'done' },
        { title: 'Fix the bug', status: 'in-progress' },
        { title: 'Ship', status: 'todo' },
      ],
    },
  })
})

test('a spyria-agent tool call made while a Task call is open belongs to its subagent, whatever the Task is titled', () => {
  const task = acpUpdate(
    3,
    { sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Explore the repo', kind: 'think', status: 'pending' },
    false,
  )
  const taskStep = agentProjectionOf(
    acpUpdate(4, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'task-1',
      title: 'Explore the repo',
      kind: 'think',
      status: 'in_progress',
      rawInput: { description: 'Explore the repo', subagent_type: 'Explore' },
    }),
  )
  expect(taskStep).toMatchObject({ type: 'step', step: { type: 'tool', name: 'Task', result: null } })
  const open = [{ id: 'conversation-1:task-1', step: (taskStep && 'step' in taskStep ? taskStep.step : null) ?? null }]
  const child = acpUpdate(5, { sessionUpdate: 'tool_call', toolCallId: 'child-1', title: 'ls', kind: 'execute' }, false)
  expect(toolCallIdOf(child)).toBe('conversation-1:child-1')
  expect(subagentDelegationOf(child, open)).toMatchObject({ id: 'conversation-1:task-1' })
  expect(subagentDelegationOf(task, open)).toBeUndefined()
  const finished = [
    { id: 'conversation-1:task-1', step: { type: 'tool', name: 'Task', arguments: '{}', result: 'Done' } },
  ]
  expect(subagentDelegationOf(child, finished as typeof open)).toBeUndefined()
  expect(subagentDelegationOf(acpUpdate(6, { sessionUpdate: 'agent_message', text: 'Hi' }), open)).toBeUndefined()
})

test.each([
  [{ sessionUpdate: 'turn_end', stopReason: 'end_turn' }, 'finished'],
  [{ sessionUpdate: 'turn_end', stopReason: 'cancelled' }, 'paused'],
  [{ sessionUpdate: 'turn_end', stopReason: 'error' }, 'error'],
  [{ sessionUpdate: 'error', message: 'boom' }, 'error'],
  [{ sessionUpdate: 'agent_message', text: 'Hi' }, undefined],
])('a subagent event %o ends its execution as %s', (update, status) => {
  expect(executionStatusOf(acpUpdate(1, update))).toBe(status)
})

test.each([
  ['running', undefined],
  ['finished', 'finished'],
  ['paused', 'finished'],
  ['error', 'error'],
] as const)('a reopened turn that spyria-agent reports %s closes as %s', (executionStatus, outcome) => {
  expect(reopenedTurnOutcomeOf(executionStatus)).toBe(outcome)
})

test('a failed setup script is stored and shown as a notice with its exit code and last output lines', () => {
  const setupFailed = acpUpdate(1, {
    sessionUpdate: 'setup_failed',
    exitCode: 127,
    output: 'installing\ntool: not found',
  })
  expect(isStoredAgentEvent(setupFailed)).toBe(true)
  expect(agentProjectionOf(setupFailed)).toEqual({
    type: 'message',
    body: 'The setup script .spyria/setup.sh failed with exit code 127; the session started anyway.\ninstalling\ntool: not found',
    kind: 'notice',
  })
})
