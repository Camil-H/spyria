import { expect, test } from 'bun:test'
import { acme, createMockSnapshot, type MessageRow, type Snapshot } from '@spyria/db'
import { chatId, messageId, runtimeHostId, runtimeId } from '@spyria/kernel'
import { getDevWorkspace } from './get-dev-workspace.ts'

const devChat = chatId('chat-invoice-bug')
const stepAt = (seq: number, step: MessageRow['step']): MessageRow => ({
  id: messageId(`message-dev-${seq}`),
  workspaceId: acme,
  chatId: devChat,
  seq: 100 + seq,
  kind: 'step',
  authorId: null,
  body: '',
  attachments: [],
  step,
  replyToId: null,
  threadRootId: null,
  quotedMessageId: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const refreshKeyWith = (steps: readonly MessageRow[]) => {
  const snapshot = createMockSnapshot()
  return getDevWorkspace(acme, devChat)({ ...snapshot, messages: [...snapshot.messages, ...steps] }).refreshKey
}

test('the workspace is read again only after steps that can change files', () => {
  const unchanged = refreshKeyWith([])
  const readOnly = [
    stepAt(1, { type: 'thought', text: 'Looking', durationMilliseconds: 10 }),
    stepAt(2, { type: 'file', operation: 'read', path: 'a.ts', added: 0, removed: 0, diff: [] }),
    stepAt(3, { type: 'tool', name: 'search', arguments: '{}', result: 'ok' }),
    stepAt(4, { type: 'command', command: 'bun test', exitCode: null }),
    stepAt(5, { type: 'file', operation: 'edit', path: 'a.ts', added: 0, removed: 0, diff: [] }),
  ]
  expect(refreshKeyWith(readOnly)).toBe(unchanged)
  const finishedCommand = stepAt(4, { type: 'command', command: 'bun test', exitCode: 0 })
  expect(refreshKeyWith(readOnly.with(3, finishedCommand))).not.toBe(unchanged)
  const appliedEdit = stepAt(5, { type: 'file', operation: 'edit', path: 'a.ts', added: 1, removed: 1, diff: [] })
  expect(refreshKeyWith(readOnly.with(4, appliedEdit))).not.toBe(unchanged)
})

test('a runtime still going to sleep shows as asleep but can be woken only once stopped', () => {
  const snapshot = createMockSnapshot()
  const runtimeIn = (state: Snapshot['runtimes'][number]['state']) => {
    const runtime = {
      workspaceId: acme,
      id: runtimeId('runtime-invoice-bug'),
      chatId: devChat,
      hostId: runtimeHostId('host-1'),
      state,
      failure: null,
      hostOnline: true,
    }
    return getDevWorkspace(acme, devChat)({ ...snapshot, runtimes: [runtime] })
  }
  expect(runtimeIn('stopping')).toMatchObject({ isAsleep: true, canWake: false })
  expect(runtimeIn('stopped')).toMatchObject({ isAsleep: true, canWake: true })
  expect(runtimeIn('running')).toMatchObject({ isAsleep: false, canWake: false })
})
