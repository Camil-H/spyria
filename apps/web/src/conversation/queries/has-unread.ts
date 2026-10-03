import type { Snapshot } from '@hq/db'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'

export const hasUnread = (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => (snapshot: Snapshot) => {
  const lastReadMessageId = snapshot.readMarkers.find(
    (marker) => marker.workspaceId === workspaceId && marker.chatId === chatId && marker.memberId === memberId,
  )?.lastReadMessageId
  const chatMessages = snapshot.messages.filter((message) => message.chatId === chatId)
  const lastReadIndex = chatMessages.findIndex((message) => message.id === lastReadMessageId)
  return chatMessages
    .slice(lastReadIndex + 1)
    .some((message) => message.kind !== 'tool-call' && message.deletedAt === null && message.authorId !== memberId)
}
