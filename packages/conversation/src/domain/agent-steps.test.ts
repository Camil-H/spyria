import { expect, test } from 'bun:test'
import { type AgentEvent, agentProjectionOf } from './agent-events.ts'
import { observedStep, type StoredStep } from './agent-steps.ts'
import { messagesFromEvents, type StoredEvent } from './message-events.ts'

const textContent = (text: string) => [{ cache_prompt: false, type: 'text', text }]
const at = (second: number) => `2026-10-06T11:19:${String(second).padStart(2, '0')}.000000`
const actionEvent = (
  id: string,
  second: number,
  action: Record<string, unknown> | undefined,
  fields = {},
): AgentEvent => ({
  id,
  kind: 'ActionEvent',
  timestamp: at(second),
  source: 'agent',
  thought: textContent(''),
  ...(action && { action }),
  ...fields,
})
const observationEvent = (actionId: string, second: number, observation: Record<string, unknown>): AgentEvent => ({
  id: `observation-${actionId}`,
  kind: 'ObservationEvent',
  timestamp: at(second),
  source: 'environment',
  action_id: actionId,
  observation,
})
const stepOf = (event: AgentEvent, previousTimestamp: string | null = at(10)) => {
  const projection = agentProjectionOf(event, previousTimestamp)
  return projection?.type === 'step' ? projection.step : projection
}
const observed = (step: StoredStep | undefined, event: AgentEvent, durationMilliseconds = 1500) => {
  const projection = agentProjectionOf(event, null)
  if (!step || projection?.type !== 'observation') throw new Error('Not an observation')
  return observedStep(step, projection.observation, durationMilliseconds)
}

const terminalAction = actionEvent(
  'action-echo',
  14,
  { kind: 'TerminalAction', command: 'echo hello', is_input: false, reset: false },
  { thought: textContent('Running it.'), reasoning_content: 'Check the shell first.', tool_name: 'terminal' },
)
const terminalObservation = observationEvent('action-echo', 15, {
  kind: 'TerminalObservation',
  content: textContent('hello'),
  is_error: false,
  command: 'echo hello',
  exit_code: 0,
})

test('a terminal action becomes a running command step with the thought before it, and its observation fills it', () => {
  const step = stepOf(terminalAction)
  expect(step).toEqual({
    type: 'command',
    command: 'echo hello',
    exitCode: null,
    durationMilliseconds: null,
    output: '',
    truncatedLines: 0,
    thought: { type: 'thought', text: 'Check the shell first.\n\nRunning it.', durationMilliseconds: 4000 },
  })
  expect(observed(step as StoredStep, terminalObservation)).toEqual({
    ...(step as StoredStep),
    exitCode: 0,
    durationMilliseconds: 1500,
    output: 'hello',
  } as StoredStep)
})

test('a failed command keeps its exit code, and only the last 200 lines of a long output are kept', () => {
  const step = stepOf(actionEvent('action-long', 12, { kind: 'TerminalAction', command: 'seq 250; exit 3' }))
  const lines = Array.from({ length: 250 }, (_, index) => String(index + 1))
  expect(
    observed(
      step as StoredStep,
      observationEvent('action-long', 13, {
        kind: 'TerminalObservation',
        content: textContent(lines.join('\n')),
        exit_code: 3,
      }),
    ),
  ).toMatchObject({ exitCode: 3, output: lines.slice(50).join('\n'), truncatedLines: 50 })
})

test('a thought without text adds nothing, and a think action is one thought step', () => {
  expect(stepOf(actionEvent('action-quiet', 11, { kind: 'TerminalAction', command: 'ls' }))).not.toHaveProperty(
    'thought',
  )
  const think = actionEvent(
    'action-think',
    13,
    { kind: 'ThinkAction', thought: 'Planning the change carefully.' },
    { reasoning_content: 'Planning the change carefully.', tool_name: 'think' },
  )
  expect(stepOf(think)).toEqual({ type: 'thought', text: 'Planning the change carefully.', durationMilliseconds: 3000 })
  expect(
    observed(
      stepOf(think) as StoredStep,
      observationEvent('action-think', 14, {
        kind: 'ThinkObservation',
        content: textContent('Your thought has been logged.'),
      }),
    ),
  ).toBeUndefined()
})

test('a file edit becomes a file step whose observation adds the diff and the line counts', () => {
  const edit = stepOf(
    actionEvent('action-edit', 12, {
      kind: 'FileEditorAction',
      command: 'str_replace',
      path: '/workspace/project/src/totals.ts',
      old_str: 'export const b = 2\n',
      new_str: 'export const b = 20\nexport const bb = 21\n',
    }),
  )
  expect(edit).toEqual({ type: 'file', operation: 'edit', path: 'src/totals.ts', added: 0, removed: 0, diff: [] })
  expect(
    observed(
      edit as StoredStep,
      observationEvent('action-edit', 13, {
        kind: 'FileEditorObservation',
        command: 'str_replace',
        path: '/workspace/project/src/totals.ts',
        prev_exist: true,
        old_content: 'export const a = 1\nexport const b = 2\nexport const c = 3\n',
        new_content: 'export const a = 1\nexport const b = 20\nexport const bb = 21\nexport const c = 3\n',
      }),
    ),
  ).toEqual({
    type: 'file',
    operation: 'edit',
    path: 'src/totals.ts',
    added: 2,
    removed: 1,
    diff: [
      { kind: 'context', text: 'export const a = 1' },
      { kind: 'removed', text: 'export const b = 2' },
      { kind: 'added', text: 'export const b = 20' },
      { kind: 'added', text: 'export const bb = 21' },
      { kind: 'context', text: 'export const c = 3' },
    ],
  })
})

test('a created file is all added lines, and a viewed file is a read with no diff', () => {
  const create = stepOf(
    actionEvent('action-create', 12, {
      kind: 'FileEditorAction',
      command: 'create',
      path: '/workspace/project/notes.md',
      file_text: 'one\ntwo\n',
    }),
  )
  expect(
    observed(
      create as StoredStep,
      observationEvent('action-create', 13, {
        kind: 'FileEditorObservation',
        command: 'create',
        prev_exist: false,
        new_content: 'one\ntwo\n',
      }),
    ),
  ).toMatchObject({ operation: 'create', path: 'notes.md', added: 2, removed: 0 })
  const view = stepOf(
    actionEvent('action-view', 12, { kind: 'FileEditorAction', command: 'view', path: '/workspace/project/notes.md' }),
  )
  expect(view).toEqual({ type: 'file', operation: 'read', path: 'notes.md', added: 0, removed: 0, diff: [] })
  expect(
    observed(
      view as StoredStep,
      observationEvent('action-view', 13, { kind: 'FileEditorObservation', command: 'view', prev_exist: true }),
    ),
  ).toBeUndefined()
})

test('a task tracker plan becomes a plan step in the panel vocabulary; viewing the plan adds nothing', () => {
  expect(
    stepOf(
      actionEvent('action-plan', 12, {
        kind: 'TaskTrackerAction',
        command: 'plan',
        task_list: [
          { title: 'Read', notes: '', status: 'done' },
          { title: 'Edit', notes: '', status: 'in_progress' },
          { title: 'Test', notes: '', status: 'todo' },
        ],
      }),
    ),
  ).toEqual({
    type: 'plan',
    items: [
      { title: 'Read', status: 'done' },
      { title: 'Edit', status: 'in-progress' },
      { title: 'Test', status: 'todo' },
    ],
  })
  expect(stepOf(actionEvent('action-view-plan', 12, { kind: 'TaskTrackerAction', command: 'view' }))).toBeUndefined()
})

test('any other action becomes a tool step with its arguments, and its observation adds the result', () => {
  const search = stepOf(
    actionEvent(
      'action-search',
      12,
      { kind: 'MCPToolAction', data: { query: 'pricing' } },
      {
        tool_name: 'web_search',
        tool_call: { id: 'call_1', name: 'web_search', arguments: '{"query": "pricing"}', origin: 'completion' },
      },
    ),
  )
  expect(search).toEqual({ type: 'tool', name: 'web_search', arguments: '{"query": "pricing"}', result: null })
  expect(
    observed(
      search as StoredStep,
      observationEvent('action-search', 13, { kind: 'MCPToolObservation', content: textContent('3 results') }),
    ),
  ).toEqual({ type: 'tool', name: 'web_search', arguments: '{"query": "pricing"}', result: '3 results' })
})

test('agent and conversation errors become error steps; a malformed tool call is left to its error', () => {
  const agentError: AgentEvent = {
    id: 'agent-error',
    kind: 'AgentErrorEvent',
    timestamp: at(12),
    source: 'agent',
    tool_name: 'nonexistent_tool',
    error: "Tool 'nonexistent_tool' not found.",
  }
  const conversationError: AgentEvent = {
    id: 'conversation-error',
    kind: 'ConversationErrorEvent',
    timestamp: at(12),
    source: 'environment',
    code: 'LLMBadRequestError',
    detail: 'litellm.BadRequestError: OpenAIException - boom',
  }
  expect(stepOf(agentError)).toEqual({ type: 'error', message: "Tool 'nonexistent_tool' not found." })
  expect(stepOf(conversationError)).toEqual({
    type: 'error',
    message: 'litellm.BadRequestError: OpenAIException - boom',
  })
  expect(stepOf(actionEvent('action-malformed', 12, undefined, { tool_name: 'nonexistent_tool' }))).toBeUndefined()
})

test('a finish action is the final answer, and finish, stats and system prompt events add no step', () => {
  expect(agentProjectionOf(actionEvent('finish', 12, { kind: 'FinishAction', message: 'All done.' }), null)).toEqual({
    type: 'message',
    body: 'All done.',
  })
  const ignored: AgentEvent[] = [
    observationEvent('finish', 13, { kind: 'FinishObservation', content: textContent('All done.') }),
    { id: 'stats', kind: 'ConversationStateUpdateEvent', timestamp: at(13), key: 'stats', value: {} },
    { id: 'system', kind: 'SystemPromptEvent', timestamp: at(1), source: 'agent' },
  ]
  for (const event of ignored)
    expect(agentProjectionOf(event, null)?.type ?? 'nothing').toBeOneOf(['nothing', 'observation'])
})

const storedEvent = (seq: number, type: string, payload: unknown, id: string, second = seq): StoredEvent => ({
  workspaceId: 'acme',
  chatId: 'chat',
  id,
  seq,
  type,
  actor: type === 'agent.event' ? null : 'alice',
  payload,
  createdAt: new Date(Date.UTC(2026, 9, 6, 11, 19, second)),
})
const agentStored = (seq: number, event: AgentEvent) =>
  storedEvent(seq, 'agent.event', { replyToId: 'prompt', event }, event.id, Number(event.timestamp.slice(17, 19)))

test('messagesFromEvents projects stored agent events into steps like the live recorder and maps legacy tool calls', () => {
  const projected = messagesFromEvents([
    storedEvent(
      1,
      'message.posted',
      { kind: 'member', body: 'Say hello', detail: null, replyToId: null },
      'prompt',
      10,
    ),
    agentStored(2, terminalAction),
    agentStored(3, terminalObservation),
    agentStored(4, actionEvent('finish', 16, { kind: 'FinishAction', message: 'Done.' })),
    storedEvent(
      5,
      'message.posted',
      { kind: 'tool-call', body: 'Ran: bun install', detail: 'Done in 35s', replyToId: null },
      'legacy',
    ),
  ])
  expect(projected.map(({ id, kind, body, step, replyToId }) => ({ id, kind, body, step, replyToId }))).toEqual([
    { id: 'prompt', kind: 'member', body: 'Say hello', step: null, replyToId: null },
    {
      id: 'action-echo',
      kind: 'step',
      body: 'command',
      step: {
        type: 'command',
        command: 'echo hello',
        exitCode: 0,
        durationMilliseconds: 1000,
        output: 'hello',
        truncatedLines: 0,
        thought: { type: 'thought', text: 'Check the shell first.\n\nRunning it.', durationMilliseconds: null },
      },
      replyToId: 'prompt',
    },
    { id: 'finish', kind: 'agent', body: 'Done.', step: null, replyToId: 'prompt' },
    {
      id: 'legacy',
      kind: 'step',
      body: 'Ran: bun install',
      step: {
        type: 'command',
        command: 'Ran: bun install',
        exitCode: null,
        durationMilliseconds: null,
        output: 'Done in 35s',
        truncatedLines: 0,
      },
      replyToId: null,
    },
  ])
})
