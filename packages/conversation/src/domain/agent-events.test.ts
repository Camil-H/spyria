import { expect, test } from 'bun:test'
import {
  type AgentEvent,
  agentNotices,
  agentProjectionOf,
  isStoredAgentEvent,
  startFailureNoticeOf,
  streamedTextOf,
  turnEndNoticeOf,
} from './agent-events.ts'
import { messagesFromEvents, type StoredEvent } from './message-events.ts'
import { type StreamedReply, streamedReplyAfter, visibleStreamedReply } from './streamed-reply.ts'

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
const terminalAction = agentEvent(
  'ActionEvent',
  { source: 'agent', action: { kind: 'TerminalAction', command: 'echo hello' }, thought: textContent('Running it.') },
  'action-echo',
)
const terminalObservation = agentEvent('ObservationEvent', {
  source: 'environment',
  action_id: 'action-echo',
  observation: { kind: 'TerminalObservation', content: textContent('hello'), exit_code: 0 },
})
const statusUpdate = (value: string) =>
  agentEvent('ConversationStateUpdateEvent', { source: 'environment', key: 'execution_status', value })

test('an agent message becomes an agent message and a user message is not projected', () => {
  expect(agentProjectionOf(agentMessage)).toEqual({
    type: 'message',
    kind: 'agent',
    body: 'Understood, working on it.',
  })
  expect(agentProjectionOf(userMessage)).toBeUndefined()
})

test('a terminal action becomes a tool call and its observation fills the detail', () => {
  expect(agentProjectionOf(terminalAction)).toEqual({ type: 'message', kind: 'tool-call', body: 'echo hello' })
  expect(agentProjectionOf(terminalObservation)).toEqual({ type: 'detail', actionId: 'action-echo', detail: 'hello' })
})

test('a finish action becomes an agent message with its final answer', () => {
  const finish = agentEvent('ActionEvent', { source: 'agent', action: { kind: 'FinishAction', message: 'All done.' } })
  expect(agentProjectionOf(finish)).toEqual({ type: 'message', kind: 'agent', body: 'All done.' })
})

test('finished, error and stuck statuses end the turn; running does not', () => {
  for (const outcome of ['finished', 'error', 'stuck'] as const)
    expect(agentProjectionOf(statusUpdate(outcome))).toEqual({ type: 'turn-end', outcome })
  expect(agentProjectionOf(statusUpdate('running'))).toBeUndefined()
})

test('other kinds and blank messages stay in the event log only', () => {
  const ignored = [
    agentEvent('SystemPromptEvent', { source: 'agent', system_prompt: { text: 'You are OpenHands' } }),
    agentEvent('ConversationStateUpdateEvent', { key: 'stats', value: {} }),
    agentEvent('ActionEvent', { source: 'agent', action: { kind: 'FileEditorAction', path: '/workspace/a.txt' } }),
    agentEvent('ConversationErrorEvent', { source: 'environment', code: 'LLMServiceUnavailableError' }),
    agentEvent('MessageEvent', { source: 'agent', llm_message: { role: 'assistant', content: textContent('  ') } }),
  ]
  for (const event of ignored) expect(agentProjectionOf(event)).toBeUndefined()
})

test('streaming deltas and the per-connection full state are never stored; every other event is', () => {
  const delta = agentEvent('StreamingDeltaEvent', { source: 'agent', content: 'Understood, ' })
  expect(isStoredAgentEvent(delta)).toBe(false)
  expect(streamedTextOf(delta)).toBe('Understood, ')
  expect(isStoredAgentEvent(agentEvent('ConversationStateUpdateEvent', { key: 'full_state', value: {} }))).toBe(false)
  for (const event of [agentMessage, userMessage, terminalAction, terminalObservation, statusUpdate('finished')]) {
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

const storedAgentEvent = (seq: number, event: AgentEvent, replyToId = 'prompt'): StoredEvent => ({
  workspaceId: 'acme',
  chatId: 'chat',
  id: event.id,
  seq,
  type: 'agent.event',
  actor: null,
  payload: { replyToId, event },
  createdAt: new Date(Date.UTC(2026, 9, 5, 20, seq)),
})

test('messagesFromEvents projects stored agent events like the live bridge, so a rebuild keeps them', () => {
  const prompt: StoredEvent = {
    workspaceId: 'acme',
    chatId: 'chat',
    id: 'prompt',
    seq: 1,
    type: 'message.posted',
    actor: 'alice',
    payload: { kind: 'member', body: 'Find the latest pricing', detail: null, replyToId: null },
    createdAt: new Date(Date.UTC(2026, 9, 5, 20, 1)),
  }
  const projected = messagesFromEvents([
    prompt,
    storedAgentEvent(2, userMessage),
    storedAgentEvent(3, terminalAction),
    storedAgentEvent(4, terminalObservation),
    storedAgentEvent(5, agentMessage),
    storedAgentEvent(6, statusUpdate('finished')),
  ])
  expect(
    projected.map(({ id, seq, kind, authorId, body, detail, replyToId }) => ({
      id,
      seq,
      kind,
      authorId,
      body,
      detail,
      replyToId,
    })),
  ).toEqual([
    {
      id: 'prompt',
      seq: 1,
      kind: 'member',
      authorId: 'alice',
      body: 'Find the latest pricing',
      detail: null,
      replyToId: null,
    },
    {
      id: 'action-echo',
      seq: 3,
      kind: 'tool-call',
      authorId: null,
      body: 'echo hello',
      detail: 'hello',
      replyToId: 'prompt',
    },
    {
      id: agentMessage.id,
      seq: 5,
      kind: 'agent',
      authorId: null,
      body: 'Understood, working on it.',
      detail: null,
      replyToId: 'prompt',
    },
  ])
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
