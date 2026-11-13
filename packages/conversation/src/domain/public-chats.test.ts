import { expect, test } from 'bun:test'
import { type ChatId, chatId, type MemberId, memberId, messageId } from '@spyria/kernel'
import {
  type PublicChat,
  type PublicChatMessage,
  publicChatFilterOf,
  publicChatHitsOf,
  publicChatListOf,
  publicChatMessagesFetched,
  publicChatReadingOf,
  publicChatSearchOf,
  publicChatsListed,
  publicChatTranscriptOf,
} from './public-chats.ts'

const general: PublicChat = {
  id: chatId('chat-general'),
  name: 'General',
  type: 'channel',
  projectName: null,
  lastMessageAt: new Date('2026-11-10T09:00:00Z'),
}
const pricing: PublicChat = {
  id: chatId('chat-pricing'),
  name: 'Pricing study',
  type: 'runtime',
  projectName: 'Sales',
  lastMessageAt: new Date('2026-11-12T09:00:00Z'),
}
const quiet: PublicChat = {
  id: chatId('chat-quiet'),
  name: 'Quiet',
  type: 'channel',
  projectName: null,
  lastMessageAt: null,
}
const names: Record<string, string> = { alice: 'Alice', bob: 'Bob' }
const memberName = (id: MemberId) => names[id] ?? 'a member'
const messageOf = (fields: Omit<Partial<PublicChatMessage>, 'id'> & { id: string }): PublicChatMessage => ({
  chatId: general.id,
  kind: 'member',
  authorId: memberId('alice'),
  step: null,
  body: 'Hello',
  createdAt: new Date('2026-11-10T09:00:00Z'),
  threadRootId: null,
  threadReplies: 0,
  ...fields,
  id: messageId(fields.id),
})

test('the arguments of the public chat tools are read leniently and refused with a reason the agent can act on', () => {
  expect(publicChatFilterOf(undefined)).toEqual({ name: '', type: null })
  expect(publicChatFilterOf({ name: ' Pricing ', kind: 'ai_chat' })).toEqual({ name: 'pricing', type: 'runtime' })
  expect(publicChatFilterOf({ kind: 'channel' })).toEqual({ name: '', type: 'channel' })
  expect(publicChatFilterOf({ kind: 'private' })).toEqual({ refusal: 'kind is one of channel, ai_chat' })
  expect(publicChatSearchOf({ query: ' Launch  \n Date ' })).toEqual({ needle: 'launch date', chatId: null })
  expect(publicChatSearchOf({ query: 'x', chatId: 'chat-general' })).toEqual({
    refusal: 'Give at least 2 characters to search',
  })
  expect(publicChatSearchOf({ query: 'a'.repeat(201) })).toEqual({ refusal: 'The query is longer than 200 characters' })
  expect(publicChatSearchOf({ query: 'launch', chatId: 'chat-general' })).toEqual({
    needle: 'launch',
    chatId: 'chat-general' as ChatId,
  })
  expect(publicChatReadingOf({})).toEqual({ refusal: 'Give the id of the public chat to read' })
  expect(publicChatReadingOf({ chatId: 'chat-general', before: '', threadId: 'message-1' })).toEqual({
    chatId: chatId('chat-general'),
    beforeId: null,
    threadRootId: messageId('message-1'),
  })
})

test('the list gives the public chats most recently active first, filtered by name and kind, and says when none matches', () => {
  expect(publicChatListOf([general, quiet, pricing], { name: '', type: null })).toBe(
    [
      '- Pricing study (AI chat, project Sales, id chat-pricing): latest message 2026-11-12T09:00:00.000Z',
      '- General (channel, id chat-general): latest message 2026-11-10T09:00:00.000Z',
      '- Quiet (channel, id chat-quiet): no messages',
    ].join('\n'),
  )
  expect(publicChatListOf([general, pricing], { name: 'pric', type: null })).toStartWith('- Pricing study')
  expect(publicChatListOf([general, pricing], { name: '', type: 'channel' })).toStartWith('- General')
  expect(publicChatListOf([general], { name: 'pricing', type: null })).toBe('No public chat matches.')
})

test('a long list stops at its limit and says how many chats it left out', () => {
  const chats = Array.from({ length: publicChatsListed + 3 }, (_, index) => ({ ...quiet, id: chatId(`chat-${index}`) }))
  const listed = publicChatListOf(chats, { name: '', type: null }).split('\n')
  expect(listed).toHaveLength(publicChatsListed + 1)
  expect(listed.at(-1)).toBe('3 more; filter by name.')
})

test('a search hit names its chat, message, thread, author and date with the words around the match', () => {
  const hits = [
    messageOf({ id: 'message-2', body: 'We ship the launch on Friday', threadRootId: messageId('message-1') }),
    messageOf({ id: 'message-3', chatId: pricing.id, kind: 'agent', authorId: null, body: 'Launch price is $20' }),
    messageOf({ id: 'message-4', chatId: chatId('chat-gone'), body: 'launch' }),
  ]
  expect(publicChatHitsOf(hits, [general, pricing], 'launch', memberName)).toBe(
    [
      '- General (channel, id chat-general), message message-2, in thread message-1, Alice at 2026-11-10T09:00:00.000Z:',
      '  We ship the launch on Friday',
      '- Pricing study (AI chat, project Sales, id chat-pricing), message message-3, Agent at 2026-11-10T09:00:00.000Z:',
      '  Launch price is $20',
    ].join('\n'),
  )
  expect(publicChatHitsOf([], [general], 'launch', memberName)).toBe('No message of a public chat matches.')
})

test('a transcript reads oldest first, points to threads and to earlier messages, and cuts a very long message', () => {
  const reading = { chatId: general.id, beforeId: null, threadRootId: null }
  const transcript = publicChatTranscriptOf(
    general,
    [
      messageOf({ id: 'message-1', threadReplies: 2 }),
      messageOf({ id: 'message-2', authorId: memberId('bob'), body: 'b'.repeat(1600) }),
      messageOf({ id: 'message-3', step: { type: 'dev_loop_prompt' }, body: 'Fix the review' }),
    ],
    reading,
    memberName,
  )
  expect(transcript).toBe(
    [
      'General (channel, id chat-general), oldest first:',
      '',
      '[message-1] Alice at 2026-11-10T09:00:00.000Z:\nHello\n  (2 replies in its thread: threadId message-1)',
      '',
      `[message-2] Bob at 2026-11-10T09:00:00.000Z:\n${'b'.repeat(1500)}… [cut]`,
      '',
      '[message-3] Quality gates at 2026-11-10T09:00:00.000Z:\nFix the review',
    ].join('\n'),
  )
  const fetched = Array.from({ length: publicChatMessagesFetched }, (_, index) =>
    messageOf({ id: `message-${index + 7}` }),
  )
  expect(publicChatTranscriptOf(general, fetched, reading, memberName)).toEndWith(
    '\n\nEarlier messages: before message-8',
  )
  expect(publicChatTranscriptOf(general, fetched, reading, memberName)).not.toContain('[message-7]')
  expect(publicChatTranscriptOf(general, fetched.slice(1), reading, memberName)).not.toContain('Earlier messages')
  expect(publicChatTranscriptOf(general, [], { ...reading, beforeId: messageId('message-1') }, memberName)).toBe(
    'General (channel, id chat-general): no messages before this one.',
  )
  expect(publicChatTranscriptOf(general, [], { ...reading, threadRootId: messageId('message-1') }, memberName)).toBe(
    'General (channel, id chat-general), thread message-1: no messages.',
  )
})
