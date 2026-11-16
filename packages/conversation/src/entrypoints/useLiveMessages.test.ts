import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
import type { ConversationItem, ConversationMessage } from '../queries/get-conversation.ts'
import { withLiveMessage } from './useLiveMessages.ts'

const prompt = messageId('message-prompt')
const messageOf = (id: string, kind: ConversationMessage['kind'], replyToId: typeof prompt | null) =>
  ({
    id: messageId(id),
    kind,
    authorName: 'Agent',
    authorAvatar: null,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    body: id,
    attachments: [],
    step: null,
    replyToId,
    canEdit: false,
    isQueued: false,
    isDeleted: false,
    isEdited: false,
    isRunning: true,
    canReply: false,
    isOnViewersPrompt: false,
    canQuote: false,
    quote: null,
    thread: null,
    runtimes: [],
  }) satisfies ConversationMessage

test('text the agent streams in a running turn shows below the fold of its finished steps', () => {
  const items: ConversationItem[] = [
    { type: 'message', message: messageOf('message-prompt', 'member', null) },
    { type: 'fold', id: `${prompt}:0`, promptId: prompt, label: 'Working · 2 steps', steps: [] },
    { type: 'message', message: messageOf('message-later', 'member', null) },
  ]
  const shown = withLiveMessage(items, messageOf('message-live', 'agent', prompt))
  expect(shown.map((item) => (item.type === 'fold' ? 'fold' : String(item.message.id)))).toEqual([
    'message-prompt',
    'fold',
    'message-live',
    'message-later',
  ])
})
