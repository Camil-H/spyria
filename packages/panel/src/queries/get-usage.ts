import { findChat, inChat, memberName, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

const sumBy = (rows: readonly { tokens: number; costCents: number }[]) => ({
  tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
  costCents: rows.reduce((sum, row) => sum + row.costCents, 0),
})

export const getUsage = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return { rows: [], total: sumBy([]) }
  const isInChat = inChat(workspaceId, chatId)
  const promptingMemberIds = [
    chat.ownerId,
    ...snapshot.chatMembers.filter((row) => isInChat(row) && row.role === 'Can prompt').map((row) => row.memberId),
  ].filter((memberId, index, memberIds) => memberIds.indexOf(memberId) === index)
  const rows = promptingMemberIds.map((memberId) => ({
    memberId,
    name: memberName(snapshot, workspaceId, memberId),
    ...sumBy(snapshot.usageEntries.filter((entry) => isInChat(entry) && entry.memberId === memberId)),
  }))
  return { rows, total: sumBy(rows) }
}
