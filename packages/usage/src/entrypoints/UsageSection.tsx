import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { LabelledSection } from '@hq/ui'
import { useState } from 'react'
import { getWorkspaceUsage } from '../queries/get-workspace-usage.ts'
import { currentMonth, pickableMonths } from './format.ts'
import { MonthPicker } from './MonthPicker.tsx'
import { UsageTable } from './UsageTable.tsx'

export const UsageSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const [month, setMonth] = useState(currentMonth)
  const usage = useQuery(getWorkspaceUsage(workspaceId, month))
  return (
    <LabelledSection title="Usage">
      <MonthPicker months={pickableMonths(usage.months, currentMonth())} month={month} onChange={setMonth} />
      {usage.total.calls === 0 && usage.total.tokens === 0 ? (
        <p className="text-sm text-muted">No usage this month</p>
      ) : (
        <>
          <UsageTable
            label="Usage by member"
            heading="Member"
            rows={usage.byMember.map((row) => ({ ...row, key: row.memberId }))}
            total={usage.total}
          />
          <UsageTable
            label="Usage by project"
            heading="Project"
            rows={usage.byProject.map((row) => ({ ...row, key: row.projectId ?? 'none' }))}
            total={usage.total}
          />
        </>
      )}
    </LabelledSection>
  )
}
