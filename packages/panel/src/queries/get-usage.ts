import { inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { getMembers } from './get-members.ts'

const sumBy = (rows: readonly { tokens: number; costCents: number }[]) => ({
  tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
  costCents: rows.reduce((sum, row) => sum + row.costCents, 0),
})

export const getUsage = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const entriesInChat = snapshot.usageEntries.filter(inChat(workspaceId, chatId))
  const rows = getMembers(
    workspaceId,
    chatId,
  )(snapshot)
    .filter((member) => member.role === 'Owner' || member.role === 'Can prompt')
    .map(({ memberId, name }) => ({
      memberId,
      name,
      ...sumBy(entriesInChat.filter((entry) => entry.memberId === memberId)),
    }))
  return { rows, total: sumBy(rows) }
}
