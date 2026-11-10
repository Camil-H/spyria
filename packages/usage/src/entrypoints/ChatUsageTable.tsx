import { useQuery, useScoped } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { getChatUsage, isLocalSession } from '../queries/get-chat-usage.ts'
import { UsageTable } from './UsageTable.tsx'

export const ChatUsageTable = ({ workspaceId, chatId }: { workspaceId: WorkspaceId; chatId: ChatId }) => {
  const usage = useQuery(getChatUsage, workspaceId, chatId)
  const isComplete = useScoped(workspaceId, 'chatUsage', { chatId })?.isComplete === true
  if (useQuery(isLocalSession, workspaceId, chatId))
    return <p className="text-sm text-muted">Subscription session on your machine, not metered by Spyria</p>
  if (!isComplete) return null
  return (
    <div className="flex flex-col gap-3">
      <UsageTable
        label="Chat usage"
        heading="Member"
        rows={usage.rows.map((row) => ({ ...row, key: row.memberId }))}
        total={usage.total}
      />
      <UsageTable
        label="Usage by model"
        heading="Model"
        rows={usage.models.map((row) => ({ ...row, key: row.model }))}
        total={usage.total}
      />
    </div>
  )
}
