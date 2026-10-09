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
