import { findChat, inChat, memberNamesIn, type Snapshot } from '@hq/db'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import { type ChatUsage, monthsNewestFirst, sumUsage, type UsageMonth } from '../domain/usage.ts'

export const getChatUsage =
  (workspaceId: WorkspaceId, chatId: ChatId, month: UsageMonth) =>
  (snapshot: Snapshot): ChatUsage => {
    const chat = findChat(snapshot, workspaceId, chatId)
    const entries = snapshot.usageEntries.filter(inChat(workspaceId, chatId))
    const entriesOfMonth = entries.filter((entry) => entry.month === month)
    const nameOf = memberNamesIn(snapshot, workspaceId)
    const memberIds = new Set<MemberId>([
      ...(chat ? [chat.ownerId] : []),
      ...snapshot.chatMembers
        .filter((member) => inChat(workspaceId, chatId)(member) && member.role === 'Can prompt')
        .map((member) => member.memberId),
      ...entriesOfMonth.map((entry) => entry.memberId),
    ])
    const rows = [...memberIds].map((memberId) => ({
      memberId,
      name: nameOf(memberId),
      ...sumUsage(entriesOfMonth.filter((entry) => entry.memberId === memberId)),
    }))
    return { months: monthsNewestFirst(entries), rows, total: sumUsage(rows) }
  }

export const isLocalSession = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  findChat(snapshot, workspaceId, chatId)?.localSession === true
