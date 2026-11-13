import { chatIn, inChat, memberNamesIn, type Snapshot } from '@spyria/db'
import { type ChatId, can, type MemberId, modelNameOf, type WorkspaceId } from '@spyria/kernel'
import { type ChatUsage, showsChatUsage, sumUsage } from '../domain/usage.ts'

const usageChatIn = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) => {
  const chat = chatIn(snapshot, workspaceId, chatId)
  return chat && showsChatUsage(chat) ? chat : undefined
}

export const getChatUsage =
  (workspaceId: WorkspaceId, chatId: ChatId) =>
  (snapshot: Snapshot): ChatUsage => {
    const chat = usageChatIn(snapshot, workspaceId, chatId)
    const entries = snapshot.usageEntries.filter(inChat(workspaceId, chatId))
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
      ...entries.map((entry) => entry.memberId),
    ])
    const entriesByMember = Map.groupBy(entries, (entry) => entry.memberId)
    const rows = [...memberIds].map((memberId) => ({
      memberId,
      name: nameOf(memberId),
      ...sumUsage(entriesByMember.get(memberId) ?? []),
    }))
    const models = [...Map.groupBy(entries, (entry) => entry.model)]
      .map(([model, modelEntries]) => ({ model, name: modelNameOf(model), ...sumUsage(modelEntries) }))
      .toSorted((first, second) => second.costMicros - first.costMicros || first.name.localeCompare(second.name))
    return { rows, models, total: sumUsage(rows) }
  }

export const isLocalSession = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  usageChatIn(snapshot, workspaceId, chatId)?.localSession === true
