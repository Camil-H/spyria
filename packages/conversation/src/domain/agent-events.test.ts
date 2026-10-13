import { expect, test } from 'bun:test'
import {
  type AgentEvent,
  agentNotices,
  agentProjectionOf,
  isStoredAgentEvent,
  notReadyNoticeOf,
  recordedLengthOf,
  startFailureNoticeOf,
  streamedTextEventOf,
  streamedTextOf,
  turnEndNoticeOf,
  waitingNotices,
} from './agent-events.ts'
import claudeCodeToolCalls from './claude-code-tool-calls.fixture.json'
import { messagesFromEvents } from './message-events.ts'
import { type StreamedReply, storedStreamedReply, streamedReplyAfter, visibleStreamedReply } from './streamed-reply.ts'

const agentEvent = (kind: string, fields: Record<string, unknown> = {}, id = `event-${kind}`): AgentEvent => ({
  id,
  kind,
  timestamp: '2026-10-05T20:21:15.560592',
  ...fields,
})
const textContent = (text: string) => [{ type: 'text', text }]
const agentMessage = agentEvent('MessageEvent', {
  source: 'agent',
  llm_message: { role: 'assistant', content: textContent('Understood, working on it.') },
})
const userMessage = agentEvent('MessageEvent', {
  source: 'user',
  llm_message: { role: 'user', content: textContent('Find the latest pricing') },
})
const statusUpdate = (value: string) =>
  agentEvent('ConversationStateUpdateEvent', { source: 'environment', key: 'execution_status', value })

test('an agent message becomes an agent message and a user message is not projected', () => {
  expect(agentProjectionOf(agentMessage, null)).toEqual({ type: 'message', body: 'Understood, working on it.' })
  expect(agentProjectionOf(userMessage, null)).toBeUndefined()
})

test('a condensation becomes the context condensed notice and a condensation request is not projected', () => {
  const condensation = agentEvent('Condensation', { source: 'environment', summary: 'Earlier work', summary_offset: 2 })
  expect(agentProjectionOf(condensation, null)).toEqual({
    type: 'message',
    body: 'Context condensed · earlier steps summarized',
    kind: 'notice',
  })
  expect(agentProjectionOf(agentEvent('CondensationRequest', { source: 'environment' }), null)).toBeUndefined()
})

test('finished, error and stuck statuses end the turn; running does not', () => {
  for (const outcome of ['finished', 'error', 'stuck'] as const)
    expect(agentProjectionOf(statusUpdate(outcome), null)).toEqual({ type: 'turn-end', outcome })
  expect(agentProjectionOf(statusUpdate('running'), null)).toBeUndefined()
})

test('streaming deltas and the per-connection full state are never stored; every other event is', () => {
  const delta = agentEvent('StreamingDeltaEvent', { source: 'agent', content: 'Understood, ' })
  const reasoningDelta = agentEvent('StreamingDeltaEvent', { source: 'agent', content: '', reasoning_content: 'Hmm' })
  expect(isStoredAgentEvent(delta)).toBe(false)
  expect(isStoredAgentEvent(reasoningDelta)).toBe(false)
  expect(streamedTextOf(delta)).toEqual({ text: 'Understood, ', isReasoning: false })
  expect(streamedTextOf(reasoningDelta)).toEqual({ text: 'Hmm', isReasoning: true })
  expect(isStoredAgentEvent(agentEvent('ConversationStateUpdateEvent', { key: 'full_state', value: {} }))).toBe(false)
  for (const event of [agentMessage, userMessage, statusUpdate('finished')]) {
    expect(isStoredAgentEvent(event)).toBe(true)
    expect(streamedTextOf(event)).toBeUndefined()
  }
})

test('a turn ends with a notice on error or stuck, or when it finished without any reply', () => {
  expect(turnEndNoticeOf('finished', true)).toBeUndefined()
  expect(turnEndNoticeOf('finished', false)).toBe(agentNotices.noReply)
  expect(turnEndNoticeOf('error', true)).toBe(agentNotices.stoppedWithError)
  expect(turnEndNoticeOf('stuck', false)).toBe(agentNotices.stoppedWithError)
})

test('a runtime that cannot be placed reads as no host, any other failure as could not start', () => {
  expect(agentNotices.noHost).toBe('No runtime host is available')
  expect(agentNotices.couldNotStart).toBe('The agent could not start')
  expect(startFailureNoticeOf('no_host')).toBe(agentNotices.noHost)
  expect(startFailureNoticeOf('no_capacity')).toBe(agentNotices.noHost)
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

test('a Claude Code tool call is one step updated by its tool call id, and the finish text is the answer with its thinking as a thought', () => {
  const toolCall = (status: string, fields: Record<string, unknown> = {}) =>
    agentEvent(
      'ACPToolCallEvent',
      { tool_call_id: 'toolu_1', title: 'Terminal', tool_kind: 'execute', status, raw_input: {}, ...fields },
      `event-${status}`,
    )
  const finish = agentEvent('ActionEvent', {
    reasoning_content: 'I will run a command.',
    action: { kind: 'FinishAction', message: 'It printed hi.' },
    tool_name: 'finish',
  })
  const stored = [
    toolCall('pending'),
    toolCall('completed', { raw_input: { command: 'echo hi' }, raw_output: 'hi\n' }),
    finish,
  ].map((event, index) => ({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: event.id,
    seq: index + 1,
    type: 'agent.event',
    actor: null,
    payload: { replyToId: 'prompt-1', event },
    createdAt: new Date(Date.parse('2026-10-09T10:00:00Z') + index * 1000),
  }))
  expect(messagesFromEvents(stored).map(({ id, kind, body, step }) => ({ id, kind, body, step }))).toEqual([
    {
      id: 'toolu_1',
      kind: 'step',
      body: 'command',
      step: {
        type: 'command',
        command: 'echo hi',
        exitCode: 0,
        durationMilliseconds: 1000,
        output: 'hi\n',
        truncatedLines: 0,
      },
    },
    {
      id: finish.id,
      kind: 'agent',
      body: 'It printed hi.',
      step: { type: 'thought', text: 'I will run a command.', durationMilliseconds: 0 },
    },
  ])
})

test('Claude Code edits, reads and HQ tools get their step types, and a subagent’s calls keep their ids inside its group', () => {
  const subagent = { id: 'toolu_task', model: '', modelName: '', task: '' }
  const diff = [{ type: 'diff', path: '/workspace/project/notes.md', old_text: null, new_text: 'one\ntwo\n' }]
  const toolCall = (id: string, status: string, fields: Record<string, unknown>) =>
    agentEvent('ACPToolCallEvent', { tool_call_id: id, status, raw_input: {}, ...fields }, `event-${id}-${status}`)
  const stored = [
    {
      event: toolCall('toolu_write', 'pending', { title: 'Write notes.md', tool_kind: 'edit', content: diff }),
      delegation: subagent,
    },
    {
      event: toolCall('toolu_write', 'completed', { title: 'Write notes.md', tool_kind: 'edit', content: diff }),
      delegation: subagent,
    },
    {
      event: toolCall('toolu_read', 'pending', {
        title: 'Read notes.md',
        tool_kind: 'read',
        raw_input: { file_path: '/workspace/project/notes.md' },
      }),
    },
    { event: toolCall('toolu_mcp', 'pending', { title: 'mcp__hq__fake-whoami', tool_kind: 'other' }) },
    {
      event: toolCall('toolu_mcp', 'completed', {
        title: 'mcp__hq__fake-whoami',
        tool_kind: 'other',
        raw_output: 'you are bob',
      }),
    },
  ].map(({ event, delegation }, index) => ({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: event.id,
    seq: index + 1,
    type: 'agent.event',
    actor: null,
    payload: { replyToId: 'prompt-1', event, ...(delegation && { delegation }) },
    createdAt: new Date(Date.parse('2026-10-09T10:00:00Z') + index * 1000),
  }))
  expect(messagesFromEvents(stored).map(({ id, step }) => ({ id, step }))).toEqual([
    {
      id: 'toolu_write',
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
    { id: 'toolu_read', step: { type: 'file', operation: 'read', path: 'notes.md', added: 0, removed: 0, diff: [] } },
    { id: 'toolu_mcp', step: { type: 'tool', name: 'whoami (fake)', arguments: '{}', result: 'you are bob' } },
  ])
})

test('a Codex command and an HQ tool call start in progress and finish with Codex’s output shapes', () => {
  const toolCall = (id: string, status: string, fields: Record<string, unknown>) =>
    agentEvent('ACPToolCallEvent', { tool_call_id: id, status, ...fields }, `event-${id}-${status}`)
  const command = { title: 'echo hello', tool_kind: 'execute', raw_input: { command: 'echo hello' } }
  const mcp = {
    title: 'mcp.hq.fake-whoami',
    tool_kind: 'execute',
    raw_input: { server: 'hq', tool: 'fake-whoami', arguments: { verbose: true } },
  }
  const stored = [
    toolCall('call_command', 'in_progress', command),
    toolCall('call_command', 'completed', { ...command, raw_output: { formatted_output: 'hello\n', exit_code: 0 } }),
    toolCall('call_mcp', 'in_progress', mcp),
    toolCall('call_mcp', 'completed', {
      ...mcp,
      raw_output: { result: { content: [{ type: 'text', text: 'you are bob' }] }, error: null },
    }),
  ].map((event, index) => ({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: event.id,
    seq: index + 1,
    type: 'agent.event',
    actor: null,
    payload: { replyToId: 'prompt-1', event },
    createdAt: new Date(Date.parse('2026-10-10T10:00:00Z') + index * 1000),
  }))
  expect(messagesFromEvents(stored).map(({ id, step }) => ({ id, step }))).toEqual([
    {
      id: 'call_command',
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
      id: 'call_mcp',
      step: { type: 'tool', name: 'whoami (fake)', arguments: '{"verbose":true}', result: 'you are bob' },
    },
  ])
})

const storedEventsOf = (entries: readonly { event: AgentEvent; recordedLength?: number }[]) =>
  entries.map(({ event, recordedLength }, index) => ({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: event.id,
    seq: index + 1,
    type: 'agent.event',
    actor: null,
    payload: { replyToId: 'prompt-1', event, ...(recordedLength && { recordedLength }) },
    createdAt: new Date(Date.parse('2026-10-12T17:56:00Z') + index * 1000),
  }))

test('a real Claude Code sequence of pending then completed or failed calls ends with the final titles and inputs, every step done', () => {
  const steps = messagesFromEvents(storedEventsOf(claudeCodeToolCalls.map((event) => ({ event })))).map(
    ({ id, step }) => ({ id, step }),
  )
  expect(steps).toMatchObject([
    {
      id: 'toolu_01BawE7ZV28RVEVNShsEA3Uj',
      step: {
        type: 'command',
        command: 'ls -la /workspace/project && git -C /workspace/project log --oneline -5 2>&1 | head -20',
        exitCode: 0,
        output: expect.stringContaining('total 0'),
      },
    },
    {
      id: 'toolu_01Uietr3ZHknr6fdX1vUGHgR',
      step: {
        type: 'command',
        command: expect.stringMatching(/^cat \/workspace\/project\/CLAUDE\.md/),
        exitCode: 1,
        output: 'Exit code 1',
      },
    },
    {
      id: 'toolu_01V5JoN21hHzqnuw2hL9qAoH',
      step: { type: 'command', command: expect.stringMatching(/^which python3 node npx/), exitCode: 0 },
    },
    {
      id: 'toolu_01MNfMCpA947uCwubk6pYiyY',
      step: { type: 'tool', name: 'Skill dataviz', arguments: '', result: 'Launching skill: dataviz' },
    },
    {
      id: 'toolu_01NfP88BRpnXgBEEvbHgVRvJ',
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
  const skillCall = (status: string, rawInput: object) =>
    agentEvent(
      'ACPToolCallEvent',
      { tool_call_id: 'toolu_skill', title: 'Skill', tool_kind: 'other', status, raw_input: rawInput },
      `event-${status}`,
    )
  const [skillStep] = messagesFromEvents(
    storedEventsOf([
      { event: skillCall('pending', {}) },
      { event: skillCall('completed', { skill: 'dataviz', args: 'a bar chart of sales' }) },
    ]),
  )
  expect(skillStep?.step).toMatchObject({ type: 'tool', name: 'Skill dataviz', arguments: 'a bar chart of sales' })
  expect(JSON.stringify(skillStep?.step)).not.toContain('"skill"')
})

test('text streamed before a tool call is its own message, and the finish stores only the text not yet recorded', () => {
  const pending = agentEvent(
    'ACPToolCallEvent',
    { tool_call_id: 'toolu_1', title: 'Terminal', tool_kind: 'execute', status: 'pending', raw_input: {} },
    'event-pending',
  )
  const finish = agentEvent('ActionEvent', { action: { kind: 'FinishAction', message: 'Looking. Done.' } })
  const messages = messagesFromEvents(
    storedEventsOf([
      { event: streamedTextEventOf(pending, 'Looking. ') },
      { event: pending },
      { event: finish, recordedLength: recordedLengthOf(finish, 'Looking. ') },
    ]),
  )
  expect(messages.map(({ id, kind, body }) => ({ id, kind, body }))).toEqual([
    { id: 'event-pending-text', kind: 'agent', body: 'Looking.' },
    { id: 'toolu_1', kind: 'step', body: 'command' },
    { id: finish.id, kind: 'agent', body: 'Done.' },
  ])
  expect(recordedLengthOf(finish, 'Lost a delta. ')).toBe(0)
  expect(recordedLengthOf(finish, '')).toBe(0)
  const fullyRecorded = agentEvent('ActionEvent', {
    reasoning_content: 'Checked twice.',
    action: { kind: 'FinishAction', message: 'Looking. ' },
  })
  expect(agentProjectionOf(fullyRecorded, null, 9)).toEqual({
    type: 'step',
    step: { type: 'thought', text: 'Checked twice.', durationMilliseconds: null },
  })
})
