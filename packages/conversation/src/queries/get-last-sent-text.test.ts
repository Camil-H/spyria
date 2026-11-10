import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, globex, type MessageRow } from '@spyria/db'
import { chatId, messageId } from '@spyria/kernel'
import { getLastSentText } from './get-last-sent-text.ts'

const research = chatId('chat-research')
const threadRoot = messageId('message-root')

const messageOf = (seq: number, fields: Partial<MessageRow> = {}): MessageRow => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: research,
  seq,
  kind: 'member',
  authorId: alice,
  body: `Message ${seq}`,
  attachments: [],
  step: null,
  replyToId: null,
  threadRootId: null,
  quotedMessageId: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
  ...fields,
})

const lastSentText = (messages: MessageRow[], threadRootId: MessageRow['threadRootId'] = null) =>
  getLastSentText(acme, research, alice, threadRootId)({ ...createMockSnapshot(), messages })

test('the last sent text is the member’s latest message of the chat, as last edited', () => {
  expect(lastSentText([messageOf(3), messageOf(1), messageOf(2, { body: 'Edited' })])).toBe('Message 3')
  expect(lastSentText([messageOf(1), messageOf(2, { body: 'Edited' })])).toBe('Edited')
})

test('the last sent text skips other authors, agents, deleted or textless messages and other chats', () => {
  expect(
    lastSentText([
      messageOf(1),
      messageOf(2, { authorId: bob }),
      messageOf(3, { kind: 'agent', authorId: null }),
      messageOf(4, { deletedAt: '2026-10-01T10:00:00.000Z' }),
      messageOf(5, { body: '' }),
      messageOf(6, { chatId: chatId('chat-welcome') }),
      messageOf(7, { workspaceId: globex }),
    ]),
  ).toBe('Message 1')
  expect(lastSentText([messageOf(1, { authorId: bob })])).toBe('')
})

test('the last sent text of a thread is only from its replies, and the chat’s only from outside threads', () => {
  const messages = [messageOf(1), messageOf(2, { threadRootId: threadRoot }), messageOf(3)]
  expect(lastSentText(messages, threadRoot)).toBe('Message 2')
  expect(lastSentText(messages)).toBe('Message 3')
})
