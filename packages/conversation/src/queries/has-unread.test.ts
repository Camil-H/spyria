import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, type MessageRow } from '@spyria/db'
import { chatId, messageId } from '@spyria/kernel'
import { hasUnread } from './has-unread.ts'

const research = chatId('chat-research')

const messageOf = (seq: number, authorId: MessageRow['authorId']): MessageRow => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: research,
  seq,
  kind: authorId ? 'member' : 'agent',
  authorId,
  body: `Message ${seq}`,
  detail: null,
  step: null,
  replyToId: null,
  threadRootId: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})

const unreadFor = (threadOrderedMessages: MessageRow[], lastReadSeq: number) =>
  hasUnread(
    acme,
    research,
    alice,
  )({
    ...createMockSnapshot(),
    latestMessages: threadOrderedMessages,
    readMarkers: [{ workspaceId: acme, memberId: alice, chatId: research, lastReadSeq }],
  })

const stepOrNotice = (seq: number, kind: MessageRow['kind']): MessageRow => ({ ...messageOf(seq, null), kind })

test.each([
  [
    'a reply listed before a newer message stays unread when the marker is past that message',
    [messageOf(1, alice), messageOf(3, null), messageOf(2, alice)],
    2,
    true,
  ],
  [
    'a message listed after a reply is read when the marker is past its seq',
    [messageOf(1, bob), messageOf(3, null), messageOf(2, bob)],
    3,
    false,
  ],
  [
    'agent steps and notices never make a chat unread',
    [messageOf(1, alice), stepOrNotice(2, 'step'), stepOrNotice(3, 'notice')],
    1,
    false,
  ],
  ['an agent answer makes a chat unread', [messageOf(1, alice), stepOrNotice(2, 'step'), messageOf(3, null)], 1, true],
  [
    'a thread reply never makes a chat unread',
    [messageOf(1, alice), { ...messageOf(2, bob), threadRootId: messageId('message-1') }],
    1,
    false,
  ],
])('%s', (_, threadOrderedMessages, lastReadSeq, isUnread) => {
  expect(unreadFor(threadOrderedMessages, lastReadSeq)).toBe(isUnread)
})
