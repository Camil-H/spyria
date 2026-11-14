import type { ChatId, MemberId, MessageId } from '@spyria/kernel'
import { devLoopAuthorName, isDevLoopPrompt } from './dev-loop.ts'
import { snippetOf } from './text-search.ts'

type Refusal = { refusal: string }
type ChatKind = 'channel' | 'runtime'

export type PublicChat = Readonly<{
  id: ChatId
  name: string
  type: ChatKind
  projectName: string | null
  lastMessageAt: Date | null
}>

export type PublicChatMessage = Readonly<{
  id: MessageId
  chatId: ChatId
  kind: 'member' | 'agent'
  authorId: MemberId | null
  step: Readonly<{ type: string }> | null
  body: string
  createdAt: Date
  threadRootId: MessageId | null
  threadReplies: number
}>

export type PublicChatSearch = Readonly<{ needle: string; chatId: ChatId | null }>
export type PublicChatReading = Readonly<{ chatId: ChatId; beforeId: MessageId | null; threadRootId: MessageId | null }>

export const publicChatsListed = 100
export const publicChatHitsListed = 20
export const publicChatMessagesRead = 40
export const publicChatMessagesFetched = publicChatMessagesRead + 1
const minimumQueryLength = 2
const maximumQueryLength = 200
const maximumMessageCharacters = 1500
const maximumNameFilterLength = 100
const kindNames: Record<ChatKind, string> = { channel: 'channel', runtime: 'AI chat' }
const kindFilters: Record<string, ChatKind> = { channel: 'channel', ai_chat: 'runtime' }
export const noPublicChatRefusal = 'No public chat of this workspace has this id; list them with list_public_chats'

const readOnly = { readOnlyHint: true }
const chatIdProperty = { type: 'string', description: 'The id of a public chat, as list_public_chats gives it' }

export const listPublicChatsTool = {
  name: 'list_public_chats',
  description:
    "List the workspace's public chats, to find where its members discuss something: channels where members talk, and public AI chats where they work with an agent. Gives each chat's id, name, kind, project and latest message date, most recently active first. Private chats are never listed.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Only the chats whose name contains these words' },
      kind: { type: 'string', enum: Object.keys(kindFilters), description: 'Only channels, or only AI chats' },
    },
  },
  annotations: readOnly,
}

export const searchPublicChatsTool = {
  name: 'search_public_chats',
  description:
    "Search the messages of the workspace's public channels and public AI chats for a text, newest first, ignoring case. Gives each match with its chat, author, date and the words around it; read the conversation around a match with read_public_chat. Private chats are never searched.",
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'The text to find in messages, matched as written' },
      chatId: { ...chatIdProperty, description: 'Search only this public chat' },
    },
  },
  annotations: readOnly,
}

export const readPublicChatTool = {
  name: 'read_public_chat',
  description:
    "Read the messages of one of the workspace's public chats, members' messages and agent replies, oldest first. Gives the latest messages; pass before to read earlier ones, or threadId to read a thread's replies.",
  inputSchema: {
    type: 'object',
    required: ['chatId'],
    properties: {
      chatId: chatIdProperty,
      before: { type: 'string', description: 'A message id: read the messages before it' },
      threadId: { type: 'string', description: "The id of a thread's first message: read that thread" },
    },
  },
  annotations: readOnly,
}

export const publicChatTools = [listPublicChatsTool, searchPublicChatsTool, readPublicChatTool]

const textArgumentOf = (input: unknown, name: string) => {
  const value = (input as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' ? value.trim() : ''
}
const optionalIdOf = <Id extends string>(input: unknown, name: string) =>
  (textArgumentOf(input, name) || null) as Id | null

export const publicChatFilterOf = (input: unknown): { name: string; type: ChatKind | null } | Refusal => {
  const kind = textArgumentOf(input, 'kind')
  const type = kindFilters[kind]
  if (kind !== '' && !type) return { refusal: `kind is one of ${Object.keys(kindFilters).join(', ')}` }
  const name = textArgumentOf(input, 'name').toLowerCase()
  if (name.length > maximumNameFilterLength)
    return { refusal: `The name is longer than ${maximumNameFilterLength} characters` }
  return { name, type: type ?? null }
}

export const publicChatSearchOf = (input: unknown): PublicChatSearch | Refusal => {
  const needle = textArgumentOf(input, 'query').replace(/\s+/g, ' ').toLowerCase()
  if (needle.length < minimumQueryLength) return { refusal: `Give at least ${minimumQueryLength} characters to search` }
  if (needle.length > maximumQueryLength)
    return { refusal: `The query is longer than ${maximumQueryLength} characters` }
  return { needle, chatId: optionalIdOf<ChatId>(input, 'chatId') }
}

export const publicChatReadingOf = (input: unknown): PublicChatReading | Refusal => {
  const chatId = optionalIdOf<ChatId>(input, 'chatId')
  if (!chatId) return { refusal: 'Give the id of the public chat to read' }
  return {
    chatId,
    beforeId: optionalIdOf<MessageId>(input, 'before'),
    threadRootId: optionalIdOf<MessageId>(input, 'threadId'),
  }
}

export const authorNameOf = (message: PublicChatMessage, memberName: (memberId: MemberId) => string) =>
  isDevLoopPrompt(message) ? devLoopAuthorName : message.authorId ? memberName(message.authorId) : 'Agent'

export const authorIdsOf = (messages: readonly PublicChatMessage[]) => [
  ...new Set(messages.flatMap(({ authorId }) => (authorId ? [authorId] : []))),
]

const chatLabelOf = (chat: Pick<PublicChat, 'id' | 'name' | 'type' | 'projectName'>) =>
  `${chat.name} (${kindNames[chat.type]}${chat.projectName ? `, project ${chat.projectName}` : ''}, id ${chat.id})`

const cappedBodyOf = (body: string) =>
  body.length > maximumMessageCharacters ? `${body.slice(0, maximumMessageCharacters)}… [cut]` : body

export const publicChatListOf = (chats: readonly PublicChat[], filter: { name: string; type: ChatKind | null }) => {
  const listed = chats
    .filter(({ name, type }) => (!filter.type || type === filter.type) && name.toLowerCase().includes(filter.name))
    .toSorted((first, second) => (second.lastMessageAt?.getTime() ?? 0) - (first.lastMessageAt?.getTime() ?? 0))
  if (listed.length === 0) return 'No public chat matches.'
  const lines = listed
    .slice(0, publicChatsListed)
    .map(
      (chat) =>
        `- ${chatLabelOf(chat)}: ${chat.lastMessageAt ? `latest message ${chat.lastMessageAt.toISOString()}` : 'no messages'}`,
    )
  const more = listed.length > publicChatsListed ? `\n${listed.length - publicChatsListed} more; filter by name.` : ''
  return `${lines.join('\n')}${more}`
}

export const publicChatHitsOf = (
  hits: readonly PublicChatMessage[],
  chats: readonly PublicChat[],
  needle: string,
  memberName: (memberId: MemberId) => string,
) => {
  const lines = hits.flatMap((hit) => {
    const chat = chats.find(({ id }) => id === hit.chatId)
    if (!chat) return []
    const { before, match, after } = snippetOf(hit.body, needle)
    const thread = hit.threadRootId ? `, in thread ${hit.threadRootId}` : ''
    return [
      `- ${chatLabelOf(chat)}, message ${hit.id}${thread}, ${authorNameOf(hit, memberName)} at ${hit.createdAt.toISOString()}:\n  ${before}${match}${after}`,
    ]
  })
  return lines.length === 0 ? 'No message of a public chat matches.' : lines.join('\n')
}

export const publicChatTranscriptOf = (
  chat: PublicChat,
  messages: readonly PublicChatMessage[],
  reading: PublicChatReading,
  memberName: (memberId: MemberId) => string,
) => {
  const heading = `${chatLabelOf(chat)}${reading.threadRootId ? `, thread ${reading.threadRootId}` : ''}`
  const shown = messages.slice(-publicChatMessagesRead)
  if (shown.length === 0) return `${heading}: no messages${reading.beforeId ? ' before this one' : ''}.`
  const lines = shown.map((message) => {
    const replies =
      message.threadReplies > 0
        ? `\n  (${message.threadReplies} ${message.threadReplies === 1 ? 'reply' : 'replies'} in its thread: threadId ${message.id})`
        : ''
    return `[${message.id}] ${authorNameOf(message, memberName)} at ${message.createdAt.toISOString()}:\n${cappedBodyOf(message.body)}${replies}`
  })
  const earlier = messages.length > shown.length ? `\n\nEarlier messages: before ${shown[0]?.id}` : ''
  return `${heading}, oldest first:\n\n${lines.join('\n\n')}${earlier}`
}
