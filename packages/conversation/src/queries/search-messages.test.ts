import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot } from '@spyria/db'
import { chatId, messageId } from '@spyria/kernel'
import { getSearchResults, type SearchHit } from './search-messages.ts'

const hitOf = (hit: Partial<SearchHit>): SearchHit => ({
  id: 'message-hit',
  chatId: 'chat-research',
  authorId: alice,
  body: 'The release ships on Friday',
  createdAt: Date.parse('2026-10-01T09:00:00.000Z'),
  threadRootId: null,
  ...hit,
})

test('a search result names its chat and author and points a thread reply at its root', () => {
  const results = getSearchResults(
    acme,
    [hitOf({}), hitOf({ id: 'message-reply', threadRootId: 'message-root', authorId: null })],
    'release',
  )(createMockSnapshot())
  expect(results).toEqual([
    {
      hitId: 'message-hit',
      messageId: messageId('message-hit'),
      chatId: chatId('chat-research'),
      chatName: 'Research',
      chatType: expect.any(String),
      authorName: 'Alice',
      createdAt: '2026-10-01T09:00:00.000Z',
      snippet: { before: 'The ', match: 'release', after: ' ships on Friday' },
    },
    expect.objectContaining({ messageId: messageId('message-root'), authorName: 'Agent' }),
  ])
})

test('a hit in a chat the snapshot no longer shows, archived or unknown, is left out', () => {
  const snapshot = createMockSnapshot()
  const archived = {
    ...snapshot,
    chats: snapshot.chats.map((chat) => (chat.id === 'chat-research' ? { ...chat, archived: true } : chat)),
  }
  expect(getSearchResults(acme, [hitOf({})], 'release')(archived)).toEqual([])
  expect(getSearchResults(acme, [hitOf({ chatId: 'chat-unknown' })], 'release')(snapshot)).toEqual([])
})
