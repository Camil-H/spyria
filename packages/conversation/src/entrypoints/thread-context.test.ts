import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { threadContextOf } from './thread-context.ts'

const messageOf = (message: Partial<ConversationMessage>): ConversationMessage => ({
  id: messageId('message-root'),
  kind: 'member',
  authorName: 'Alice',
  authorAvatar: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  body: 'Can someone look at the flaky deploy?',
  attachments: [],
  step: null,
  replyToId: null,
  canEdit: false,
  isDeleted: false,
  isEdited: false,
  isRunning: false,
  canReply: true,
  thread: null,
  runtimes: [],
  ...message,
})

test('a thread copied as context names its channel and quotes its messages like a runtime seed, without its deleted messages', () => {
  const context = threadContextOf('ops', [
    messageOf({}),
    messageOf({ id: messageId('message-gone'), body: '', isDeleted: true }),
    messageOf({
      id: messageId('message-answer'),
      kind: 'agent',
      authorName: 'Agent',
      createdAt: '2026-10-01T09:05:00.000Z',
      body: 'The cache key changed.',
      attachments: [{ id: 'attachment-log', name: 'log.txt', mediaType: 'text/plain', size: 2048 }],
    }),
  ])
  expect<string>(context).toBe(
    [
      'Conversation from channel thread in #ops',
      'Alice (member, human) · 2026-10-01 09:00 UTC\nCan someone look at the flaky deploy?',
      'Agent (agent) · 2026-10-01 09:05 UTC\nThe cache key changed.\n\nAttached, not readable by you: log.txt (text/plain, 2 KB)',
    ].join('\n\n'),
  )
})
