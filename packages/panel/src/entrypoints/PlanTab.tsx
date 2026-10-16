import { useQuery } from '@hq/db/react'
import { Suspense } from 'react'
import { getPlan } from '../queries/get-plan.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

const statusLabels: Record<string, string> = { done: 'Done', 'in-progress': 'In progress', todo: 'To do' }

export const PlanTab = ({ workspaceId, chatId, Markdown }: TabProps) => {
  const { steps, approvedPlan } = useQuery(getPlan(workspaceId, chatId))
  return approvedPlan !== null ? (
    <section aria-label="Approved plan">
      <Suspense fallback={<p className="text-sm whitespace-pre-wrap">{approvedPlan}</p>}>
        <Markdown text={approvedPlan} />
      </Suspense>
    </section>
  ) : (
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
