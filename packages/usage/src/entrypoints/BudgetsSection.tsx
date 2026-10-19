import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, fieldClass, formatCost, ghostButtonClass, LabelledSection, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { type BudgetOverview, type BudgetProgress, isOverAlertLine } from '../domain/budgets.ts'
import { useUsageCommands } from './providers.tsx'

const cellClass = 'px-2 py-1.5'
const dollarsOf = (limitMicros: number | null) => (limitMicros === null ? '' : String(limitMicros / 1_000_000))

const BudgetRow = ({
  name,
  progress,
  onSave,
}: {
  name: string
  progress: BudgetProgress
  onSave: (dollars: number | null) => Promise<unknown>
}) => {
  const [dollars, setDollars] = useState(dollarsOf(progress.limitMicros))
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => setDollars(dollarsOf(progress.limitMicros)), [progress.limitMicros])
  const save = () => run(() => onSave(dollars.trim() === '' ? null : Number(dollars)))
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className={`${cellClass} text-left font-normal`}>
        {name}
      </th>
      <td className={`${cellClass} text-right`}>{formatCost(progress.spentMicros)}</td>
      <td className={`${cellClass} text-right`}>{progress.percent === null ? '—' : `${progress.percent}%`}</td>
      <td className={cellClass}>
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="No budget"
            aria-label={`Monthly budget of ${name}`}
            className={`${fieldClass} w-28`}
            value={dollars}
            onChange={(event) => setDollars(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
          />
          <button
            type="button"
            className={ghostButtonClass}
            disabled={isPending}
            aria-label={`Save the budget of ${name}`}
            onClick={save}
          >
            Save
          </button>
        </div>
        <ErrorMessage message={errorMessage} />
      </td>
    </tr>
  )
}

export const BudgetsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  const [overview, setOverview] = useState<BudgetOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    commands.readBudgets({ workspaceId }).then(setOverview, (error: Error) => setLoadError(error.message))
  }, [commands, workspaceId])
  const saveOf = (memberId: MemberId | null) => async (dollars: number | null) =>
    setOverview(await commands.saveBudget({ workspaceId, memberId, dollars }))
  const overAlertLine = overview?.members.filter(isOverAlertLine) ?? []
  return (
    <LabelledSection title="Budgets">
      <p className="text-sm text-muted">
        Monthly AI budgets in dollars, per calendar month in UTC. At 100% the member's prompts are refused until next
        month or a higher budget; leave a budget empty to remove it.
      </p>
      {overview === null ? (
        loadError ? (
          <ErrorMessage message={loadError} />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )
      ) : (
        <>
          {overAlertLine.length > 0 && (
            <LabelledSection title="Over 80% of their budget" Heading="h3" titleClass="font-medium">
              <ul className="flex flex-col gap-1 text-sm">
                {overAlertLine.map((member) => (
                  <li key={member.memberId}>
                    {member.name} · {formatCost(member.spentMicros)} of {formatCost(member.limitMicros ?? 0)} (
                    {member.percent}%)
                  </li>
                ))}
              </ul>
            </LabelledSection>
          )}
          <table aria-label="Budgets" className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className={`${cellClass} text-left font-medium`}>
                  Budget
                </th>
                <th scope="col" className={`${cellClass} text-right font-medium`}>
                  Spent this month
                </th>
                <th scope="col" className={`${cellClass} text-right font-medium`}>
                  Used
                </th>
                <th scope="col" className={`${cellClass} text-right font-medium`}>
                  Monthly budget ($)
                </th>
              </tr>
            </thead>
            <tbody>
              <BudgetRow name="Workspace total" progress={overview.workspace} onSave={saveOf(null)} />
              {overview.members.map((member) => (
                <BudgetRow
                  key={member.memberId}
                  name={member.name}
                  progress={member}
                  onSave={saveOf(member.memberId)}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </LabelledSection>
  )
}
