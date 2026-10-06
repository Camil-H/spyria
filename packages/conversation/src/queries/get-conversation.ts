import { type ChatRow, findChat, type Snapshot } from '@hq/db'
import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'

export type ConversationMessage = Readonly<{
  id: MessageId
  kind: 'member' | 'agent' | 'tool-call' | 'notice'
  authorName: string
  createdAt: string
  body: string
  detail: string | null
  replyToId: MessageId | null
  isOwn: boolean
  isDeleted: boolean
  isEdited: boolean
}>

export type Conversation = Readonly<{
  title: string
  type: ChatRow['type']
  model: string | null
  reasoningEffort: ChatRow['reasoningEffort']
  gitBranch: string | null
  ownerName: string
  origin: Readonly<{ chatId: ChatId; name: string }> | null
  isAgentWorking: boolean
  hasActiveTurn: boolean
  messages: readonly ConversationMessage[]
}>

export const getConversation =
  (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) =>
  (snapshot: Snapshot): Conversation | null => {
    const chat = findChat(snapshot, workspaceId, chatId)
    if (!chat) return null
    const memberNames = new Map(
      snapshot.memberships
        .filter((membership) => membership.workspaceId === workspaceId)
        .map((membership) => [membership.memberId, membership.displayName]),
    )
    const memberName = (memberId: MemberId | null) => (memberId && memberNames.get(memberId)) || 'Agent'
    const origin = chat.originChatId ? findChat(snapshot, workspaceId, chat.originChatId) : undefined
    const chatMessages = snapshot.messages.filter((message) => message.chatId === chatId)
    const hasActiveTurn = chat.agentTurnMessageId !== null
    return {
      title: chat.name,
      type: chat.type,
      model: chat.model,
      reasoningEffort: chat.reasoningEffort,
      gitBranch: chat.gitBranch,
      ownerName: memberName(chat.ownerId),
      origin: origin ? { chatId: origin.id, name: origin.name } : null,
      isAgentWorking: hasActiveTurn || chatMessages.some((message) => message.needsReply),
      hasActiveTurn,
      messages: chatMessages.map((message) => ({
        id: message.id,
        kind: message.kind,
        authorName: memberName(message.authorId),
        createdAt: message.createdAt,
        body: message.body,
        detail: message.detail,
        replyToId: message.replyToId,
        isOwn: message.authorId === viewerId,
        isDeleted: message.deletedAt !== null,
        isEdited: message.editedAt !== null,
      })),
    }
  }
