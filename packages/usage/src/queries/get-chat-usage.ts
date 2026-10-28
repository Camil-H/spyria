import { chatIn, inChat, memberNamesIn, type Snapshot } from '@spyria/db'
import { type ChatId, can, type MemberId, type WorkspaceId } from '@spyria/kernel'
import { type ChatUsage, monthsNewestFirst, showsChatUsage, sumUsage, type UsageMonth } from '../domain/usage.ts'

const usageChatIn = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) => {
  const chat = chatIn(snapshot, workspaceId, chatId)
  return chat && showsChatUsage(chat) ? chat : undefined
}

export const getChatUsage =
  (workspaceId: WorkspaceId, chatId: ChatId, month: UsageMonth) =>
  (snapshot: Snapshot): ChatUsage => {
    const chat = usageChatIn(snapshot, workspaceId, chatId)
    const entries = snapshot.usageEntries.filter(inChat(workspaceId, chatId))
    const entriesOfMonth = entries.filter((entry) => entry.month === month)
    const nameOf = memberNamesIn(snapshot, workspaceId)
    const postingRoleIds = new Set(
      snapshot.chatRoles
        .filter((role) => role.workspaceId === workspaceId && can(role.permissions, 'chat.post'))
        .map((role) => role.id),
    )
    const memberIds = new Set<MemberId>([
      ...(chat ? [chat.ownerId] : []),
      ...snapshot.chatMembers
        .filter((member) => inChat(workspaceId, chatId)(member) && postingRoleIds.has(member.roleId))
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
  usageChatIn(snapshot, workspaceId, chatId)?.localSession === true
