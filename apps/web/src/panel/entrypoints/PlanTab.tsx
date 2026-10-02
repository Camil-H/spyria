import { useQuery } from '@hq/db'
import { getPlan } from '../queries/get-plan.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

const statusLabels: Record<string, string> = { done: 'Done', 'in-progress': 'In progress', todo: 'To do' }

export const PlanTab = ({ workspaceId, chatId }: TabProps) => {
  const steps = useQuery(getPlan(workspaceId, chatId))
  return (
    <LabelList
      emptyMessage="No plan"
      rows={steps.map((step) => ({
        key: step.title,
        label: step.title,
        value: statusLabels[step.status] ?? step.status,
      }))}
    />
  )
}
