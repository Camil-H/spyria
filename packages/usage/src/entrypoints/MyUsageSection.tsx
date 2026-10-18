import type { MemberId, WorkspaceId } from '@hq/kernel'
import { formatCost, LabelledSection } from '@hq/ui'
import { useEffect, useState } from 'react'
import type { BudgetProgress } from '../domain/budgets.ts'
import { BudgetBar, BudgetNotice, useOwnBudgetAlert } from './BudgetNotice.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

const OwnBudget = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useUsageCommands()
  const threshold = useOwnBudgetAlert(workspaceId, memberId)
  const [budget, setBudget] = useState<BudgetProgress | null>(null)
  useEffect(() => {
    if (threshold >= 0) commands.readOwnBudget({ workspaceId }).then(setBudget, () => setBudget(null))
  }, [commands, workspaceId, threshold])
  return (
    <LabelledSection title="Monthly AI budget" Heading="h3" titleClass="font-medium">
      <BudgetNotice workspaceId={workspaceId} memberId={memberId} />
      {budget === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : budget.limitMicros === null ? (
        <p className="text-sm text-muted">No monthly budget · {formatCost(budget.spentMicros)} this month</p>
      ) : (
        <BudgetBar label="Monthly AI budget used" progress={budget} />
      )}
    </LabelledSection>
  )
}

export const MyUsageSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useUsageCommands()
  return (
    <SpendReportView
      title="My usage"
      workspaceId={workspaceId}
      readReport={commands.readOwnSpend}
      chartDimensions={['model', 'chat']}
      tableDimensions={['chat', 'model']}
    >
      <OwnBudget workspaceId={workspaceId} memberId={memberId} />
    </SpendReportView>
  )
}
