import { useQuery } from '@hq/db/react'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { useState } from 'react'
import { getChatUsage } from '../queries/get-chat-usage.ts'
import { currentMonth, pickableMonths } from './format.ts'
import { MonthPicker } from './MonthPicker.tsx'
import { UsageTable } from './UsageTable.tsx'

export const ChatUsageTable = ({ workspaceId, chatId }: { workspaceId: WorkspaceId; chatId: ChatId }) => {
  const [month, setMonth] = useState(currentMonth)
  const usage = useQuery(getChatUsage(workspaceId, chatId, month))
  return (
    <div className="flex flex-col gap-3">
      <MonthPicker months={pickableMonths(usage.months, currentMonth())} month={month} onChange={setMonth} />
      <UsageTable
        label="Chat usage"
        heading="Member"
        rows={usage.rows.map((row) => ({ ...row, key: row.memberId }))}
        total={usage.total}
      />
    </div>
  )
}
