import { expect, test } from 'bun:test'
import { agentActor, chatId, memberActor, memberId } from '@spyria/kernel'
import { type AgentEvent, agentProjectionOf } from './agent-events.ts'
import { observedStep, type StoredStep } from './agent-steps.ts'
import { messagesFromEvents, type StoredEvent } from './message-events.ts'
import { acpUpdate } from './testing.ts'

const at = (second: number) => `2026-10-06T11:19:${String(second).padStart(2, '0')}.000Z`
const toolCall = (seq: number, toolCallId: string, fields: Record<string, unknown>) =>
  acpUpdate(seq, { sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...fields }, true, at(seq))
const finished = (seq: number, toolCallId: string, fields: Record<string, unknown>) =>
  acpUpdate(seq, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...fields }, true, at(seq))
const stepOf = (event: AgentEvent) => {
  const projection = agentProjectionOf(event)
  return projection?.type === 'step' ? projection.step : projection
}
const observed = (step: StoredStep | undefined, event: AgentEvent, durationMilliseconds = 1500) => {
  const projection = agentProjectionOf(event)
  if (!step || projection?.type !== 'observation') throw new Error('Not an observation')
  return observedStep(step, projection.observation, durationMilliseconds)
}

test('a failed command keeps its exit code, and only the last 200 lines of a long output are kept', () => {
  const command = { title: 'seq 250; exit 3', kind: 'execute', rawInput: { command: 'seq 250; exit 3' } }
  const step = stepOf(toolCall(1, 'long', command))
  const lines = Array.from({ length: 250 }, (_, index) => String(index + 1))
  expect(
    observed(
      step as StoredStep,
      finished(2, 'long', {
        ...command,
        status: 'failed',
        rawOutput: { formatted_output: lines.join('\n'), exit_code: 3 },
      }),
    ),
  ).toMatchObject({ exitCode: 3, output: lines.slice(50).join('\n'), truncatedLines: 50 })
})

test('a file edit becomes a file step whose final update adds the diff with its context and the line counts', () => {
  const path = '/workspace/project/src/totals.ts'
  const edit = stepOf(toolCall(1, 'edit', { title: 'Edit src/totals.ts', kind: 'edit', rawInput: { file_path: path } }))
  expect(edit).toEqual({ type: 'file', operation: 'edit', path: 'src/totals.ts', added: 0, removed: 0, diff: [] })
  const diff = {
    type: 'diff',
    path,
    oldText: 'export const a = 1\nexport const b = 2\nexport const c = 3\n',
    newText: 'export const a = 1\nexport const b = 20\nexport const bb = 21\nexport const c = 3\n',
  }
  expect(
    observed(
      edit as StoredStep,
      finished(2, 'edit', {
        title: 'Edit src/totals.ts',
        kind: 'edit',
        rawInput: { file_path: path },
        content: [diff],
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

test('a written file is all added lines, and a read file is a read with no diff', () => {
  const path = '/workspace/project/notes.md'
  const write = { title: 'Write notes.md', kind: 'edit', rawInput: { file_path: path } }
  expect(
    observed(
      stepOf(toolCall(1, 'write', write)) as StoredStep,
      finished(2, 'write', { ...write, content: [{ type: 'diff', path, oldText: null, newText: 'one\ntwo\n' }] }),
    ),
  ).toMatchObject({ operation: 'create', path: 'notes.md', added: 2, removed: 0 })
  const read = { title: 'Read notes.md', kind: 'read', rawInput: { file_path: path } }
  const view = stepOf(toolCall(3, 'read', read))
  expect(view).toEqual({ type: 'file', operation: 'read', path: 'notes.md', added: 0, removed: 0, diff: [] })
  expect(observed(view as StoredStep, finished(4, 'read', read))).toBeUndefined()
})

const storedEvent = (seq: number, type: string, payload: unknown, id: string, second = seq): StoredEvent => ({
  workspaceId: 'acme',
  chatId: 'chat',
  id,
  seq,
  type,
  actor: type === 'agent.event' ? agentActor(chatId('chat'), null) : memberActor(memberId('alice')),
  payload,
  createdAt: new Date(Date.UTC(2026, 9, 6, 11, 19, second)),
})
const agentStored = (seq: number, event: AgentEvent) =>
  storedEvent(seq, 'agent.event', { replyToId: 'prompt', event }, event.id, Number(event.timestamp.slice(17, 19)))

test('messagesFromEvents projects stored agent events into steps like the live recorder and maps legacy tool calls', () => {
  const command = { title: 'echo hello', kind: 'execute', rawInput: { command: 'echo hello' } }
  const projected = messagesFromEvents([
    storedEvent(1, 'message.posted', { kind: 'member', body: 'Say hello', replyToId: null }, 'prompt', 10),
    agentStored(2, toolCall(14, 'echo', command)),
    agentStored(3, finished(15, 'echo', { ...command, rawOutput: { formatted_output: 'hello', exit_code: 0 } })),
    agentStored(4, acpUpdate(16, { sessionUpdate: 'agent_message', text: 'Done.' })),
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
      id: 'conversation-1:echo',
      kind: 'step',
      body: 'command',
      step: {
        type: 'command',
        command: 'echo hello',
        exitCode: 0,
        durationMilliseconds: 1000,
        output: 'hello',
        truncatedLines: 0,
      },
      replyToId: 'prompt',
    },
    { id: 'conversation-1:16', kind: 'agent', body: 'Done.', step: null, replyToId: 'prompt' },
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
