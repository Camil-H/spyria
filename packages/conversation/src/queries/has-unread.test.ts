import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, type MessageRow } from '@spyria/db'
import { chatId, messageId } from '@spyria/kernel'
import { getOldestUnreadThreadReply, hasUnread } from './has-unread.ts'

const research = chatId('chat-research')

const messageOf = (seq: number, authorId: MessageRow['authorId']): MessageRow => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: research,
  seq,
  kind: authorId ? 'member' : 'agent',
  authorId,
  body: `Message ${seq}`,
  attachments: [],
  step: null,
  replyToId: null,
  threadRootId: null,
  quotedMessageId: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  pickedUpAt: null,
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
    'a thread reply among the latest messages never makes a chat unread',
    [messageOf(1, alice), { ...messageOf(2, bob), threadRootId: messageId('message-1') }],
    1,
    false,
  ],
])('%s', (_, threadOrderedMessages, lastReadSeq, isUnread) => {
  expect(unreadFor(threadOrderedMessages, lastReadSeq)).toBe(isUnread)
})

const followedReplyOf = (seq: number, rootSeq: number, chat = research): MessageRow => ({
  ...messageOf(seq, bob),
  chatId: chat,
  threadRootId: messageId(`message-${rootSeq}`),
})

const followedSnapshotOf = (
  followedThreadReplies: MessageRow[],
  threadLastReadSeqByRootSeq: Record<number, number>,
) => ({
  ...createMockSnapshot(),
  latestMessages: [messageOf(1, bob)],
  readMarkers: [{ workspaceId: acme, memberId: alice, chatId: research, lastReadSeq: 9 }],
  followedThreadReplies,
  threadReadMarkers: Object.entries(threadLastReadSeqByRootSeq).map(([rootSeq, lastReadSeq]) => ({
    workspaceId: acme,
    memberId: alice,
    chatId: research,
    threadRootId: messageId(`message-${rootSeq}`),
    lastReadSeq,
  })),
})

test.each([
  ['a reply in a thread the member follows but never opened makes the chat unread', {}, true],
  ['a reply newer than the thread read marker makes the chat unread', { 1: 4 }, true],
  ['a reply the member has read in its thread leaves the chat read', { 1: 5 }, false],
])('%s', (_, threadLastReadSeqByRootSeq, isUnread) => {
  expect(
    hasUnread(acme, research, alice)(followedSnapshotOf([followedReplyOf(5, 1)], threadLastReadSeqByRootSeq)),
  ).toBe(isUnread)
})

test('the oldest unread reply of the chat is the one to open, past read threads and other chats', () => {
  const snapshot = followedSnapshotOf(
    [followedReplyOf(8, 3), followedReplyOf(6, 2), followedReplyOf(5, 1), followedReplyOf(4, 1, chatId('chat-other'))],
    { 1: 5 },
  )
  expect(getOldestUnreadThreadReply(acme, research, alice)(snapshot)).toBe(messageId('message-6'))
  expect(getOldestUnreadThreadReply(acme, research, alice)(followedSnapshotOf([], {}))).toBeNull()
})
