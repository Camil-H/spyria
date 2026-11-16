import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import { useQuery } from '@spyria/db/react'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import { calloutClass, tabTriggerClass } from '@spyria/ui'
import { type ComponentType, useState } from 'react'
import { countBudgetAlerts } from '../queries/budget-alerts.ts'
import { BudgetsSection } from './BudgetsSection.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

const costsTab = 'Costs'
const budgetsTab = 'AI budgets'

const CostsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  return (
    <SpendReportView
      label="Usage"
      workspaceId={workspaceId}
      readReport={commands.readWorkspaceSpend}
      readTrend={commands.readWorkspaceSpendTrend}
      chartDimensions={['member', 'project', 'model']}
      tableDimensions={['member', 'project', 'chat', 'model']}
    />
  )
}

const tabs = [
  { title: costsTab, permission: 'costs.view', Section: CostsSection },
  { title: budgetsTab, permission: 'budgets.manage', Section: BudgetsSection },
] satisfies readonly {
  title: string
  permission: WorkspacePermission
  Section: ComponentType<{ workspaceId: WorkspaceId }>
}[]

export const UsageSection = ({
  workspaceId,
  permissions,
}: {
  workspaceId: WorkspaceId
  permissions: readonly WorkspacePermission[]
}) => {
  const allowedTabs = tabs.filter((tab) => permissions.includes(tab.permission))
  const [openTab, setOpenTab] = useState<string>(allowedTabs[0]?.title ?? costsTab)
  const budgetAlertCount = useQuery(countBudgetAlerts, workspaceId, new Date().toISOString().slice(0, 10))
  const mayManageBudgets = permissions.includes('budgets.manage')
  const [firstTab] = allowedTabs
  if (!firstTab) return null
  return (
    <div className="flex flex-col gap-6">
      {mayManageBudgets && budgetAlertCount > 0 && (
        <p className={calloutClass}>
          {budgetAlertCount === 1 ? '1 member has' : `${budgetAlertCount} members have`} a budget alert.{' '}
          {allowedTabs.length > 1 && (
            <button type="button" className="underline" onClick={() => setOpenTab(budgetsTab)}>
              See the AI budgets
            </button>
          )}
        </p>
      )}
      {allowedTabs.length === 1 ? (
        <firstTab.Section workspaceId={workspaceId} />
      ) : (
        <Root value={openTab} onValueChange={setOpenTab} className="flex flex-col gap-6">
          <List aria-label="Costs and AI budgets" className="flex gap-4 border-b border-line">
            {allowedTabs.map(({ title }) => (
              <Trigger key={title} value={title} className={tabTriggerClass}>
                {title}
              </Trigger>
            ))}
          </List>
          {allowedTabs.map(({ title, Section }) => (
            <Content key={title} value={title}>
              <Section workspaceId={workspaceId} />
            </Content>
          ))}
        </Root>
      )}
    </div>
  )
}
