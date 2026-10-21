import type { Snapshot } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

const unreadChatKeysBySnapshot = new WeakMap<Snapshot, { memberId: MemberId; chatKeys: ReadonlySet<string> }>()

const unreadChatKeysOf = (snapshot: Snapshot, memberId: MemberId) => {
  const cached = unreadChatKeysBySnapshot.get(snapshot)
  if (cached?.memberId === memberId) return cached.chatKeys
  const lastReadSeqByChat = new Map(
    snapshot.readMarkers
      .filter((marker) => marker.memberId === memberId)
      .map((marker) => [`${marker.workspaceId}/${marker.chatId}`, marker.lastReadSeq]),
  )
  const chatKeys = new Set<string>()
  for (const message of snapshot.latestMessages) {
    const chatKey = `${message.workspaceId}/${message.chatId}`
    if (
      message.seq > (lastReadSeqByChat.get(chatKey) ?? 0) &&
      message.kind !== 'step' &&
      message.kind !== 'notice' &&
      message.deletedAt === null &&
      message.threadRootId === null &&
      message.authorId !== memberId
    )
      chatKeys.add(chatKey)
  }
  unreadChatKeysBySnapshot.set(snapshot, { memberId, chatKeys })
  return chatKeys
}

export const hasUnread = (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => (snapshot: Snapshot) =>
  unreadChatKeysOf(snapshot, memberId).has(`${workspaceId}/${chatId}`)
