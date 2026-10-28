import { type ChatRow, memberNamesIn, type Snapshot } from '@spyria/db'
import { type ChatId, chatId, type MemberId, type MessageId, messageId, type WorkspaceId } from '@spyria/kernel'
import { type Snippet, snippetOf } from '../domain/text-search.ts'
import { conversationChatIn } from './conversation-chat.ts'

export type SearchHit = Readonly<{
  id: string
  chatId: string
  authorId: string | null
  body: string
  createdAt: number
  threadRootId: string | null
}>

export type SearchResult = Readonly<{
  hitId: string
  messageId: MessageId
  chatId: ChatId
  chatName: string
  chatType: ChatRow['type']
  authorName: string
  createdAt: string
  snippet: Snippet
}>

export const getSearchResults =
  (workspaceId: WorkspaceId, hits: readonly SearchHit[], needle: string) =>
  (snapshot: Snapshot): readonly SearchResult[] => {
    const memberName = memberNamesIn(snapshot, workspaceId)
    return hits.flatMap((hit) => {
      const chat = conversationChatIn(snapshot, workspaceId, chatId(hit.chatId))
      if (!chat) return []
      return [
        {
          hitId: hit.id,
          messageId: messageId(hit.threadRootId ?? hit.id),
          chatId: chat.id,
          chatName: chat.name,
          chatType: chat.type,
          authorName: hit.authorId ? memberName(hit.authorId as MemberId) : 'Agent',
          createdAt: new Date(hit.createdAt).toISOString(),
          snippet: snippetOf(hit.body, needle),
        },
      ]
    })
  }
