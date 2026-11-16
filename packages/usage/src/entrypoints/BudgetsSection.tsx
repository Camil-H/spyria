import type { WorkspaceId } from '@spyria/kernel'
import {
  calloutClass,
  cardClass,
  ErrorMessage,
  failureMessageOf,
  fieldClass,
  formatCost,
  ghostButtonClass,
  LabelledSection,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useState } from 'react'
import {
  type BudgetLimits,
  type BudgetOverview,
  type BudgetPeriod,
  budgetPeriods,
  periodAdjectiveOf,
  periodTitleOf,
  type RoleBudget,
  roleTotalOf,
  workspaceTotalsOf,
} from '../domain/budgets.ts'
import { useUsageCommands } from './providers.tsx'

type DollarsByPeriod = Readonly<Record<BudgetPeriod, string>>

const cellClass = 'px-2 py-1.5'
const memberCountLabelOf = (count: number) => `${count} ${count === 1 ? 'member' : 'members'}`
const limitLabelOf = (limitMicros: number | null) => (limitMicros === null ? 'No limit' : formatCost(limitMicros))
const dollarsOf = (limits: BudgetLimits) =>
  Object.fromEntries(
    budgetPeriods.map((period) => [period, limits[period] === null ? '' : String((limits[period] ?? 0) / 1_000_000)]),
  ) as DollarsByPeriod
const dollarAmountsOf = (dollars: DollarsByPeriod) =>
  Object.fromEntries(
    budgetPeriods.map((period) => [period, dollars[period].trim() === '' ? null : Number(dollars[period])]),
  ) as Readonly<Record<BudgetPeriod, number | null>>

const RoleTotal = ({ limitMicros, memberCount }: { limitMicros: number | null; memberCount: number }) => (
  <p className="text-xs text-muted">
    {limitMicros === null
      ? 'No limit'
      : `${formatCost(limitMicros)} × ${memberCountLabelOf(memberCount)} = ${formatCost(roleTotalOf(limitMicros, memberCount) ?? 0)}`}
  </p>
)

const RoleBudgetRow = ({
  role,
  onSave,
}: {
  role: RoleBudget
  onSave: (dollars: Readonly<Record<BudgetPeriod, number | null>>) => Promise<unknown>
}) => {
  const [dollars, setDollars] = useState(() => dollarsOf(role.limits))
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => setDollars(dollarsOf(role.limits)), [role.limits])
  const save = () => run(() => onSave(dollarAmountsOf(dollars)))
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className={`${cellClass} text-left font-normal`}>
        {role.name}
      </th>
      <td className={`${cellClass} text-right`}>{role.memberCount}</td>
      {budgetPeriods.map((period) => (
        <td key={period} className={cellClass}>
          <div className="flex flex-col items-end gap-1">
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="No limit"
              aria-label={`${periodTitleOf(period)} budget per member of ${role.name}`}
              className={`${fieldClass} w-28`}
              value={dollars[period]}
              onChange={(event) => setDollars({ ...dollars, [period]: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && save()}
            />
            <RoleTotal limitMicros={role.limits[period]} memberCount={role.memberCount} />
          </div>
        </td>
      ))}
      <td className={cellClass}>
        <div className="flex justify-end">
          <button
            type="button"
            className={ghostButtonClass}
            disabled={isPending}
            aria-label={`Save the budgets of ${role.name}`}
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

const WorkspaceTotalRow = ({ roles }: { roles: readonly RoleBudget[] }) => {
  const totals = workspaceTotalsOf(roles)
  return (
    <tr className="border-t border-line font-medium">
      <th scope="row" className={`${cellClass} text-left font-medium`}>
        Workspace total
      </th>
      <td className={`${cellClass} text-right`}>{roles.reduce((count, role) => count + role.memberCount, 0)}</td>
      {budgetPeriods.map((period) => (
        <td key={period} className={`${cellClass} text-right`}>
          {limitLabelOf(totals[period])}
        </td>
      ))}
      <td className={cellClass} />
    </tr>
  )
}

const OverAlertLine = ({ overview }: { overview: BudgetOverview }) =>
  overview.overAlertLine.length > 0 && (
    <LabelledSection
      title="Over 80% of their budget"
      Heading="h3"
      titleClass="text-sm font-medium"
      className={`${calloutClass} flex flex-col gap-1`}
    >
      <ul className="flex flex-col gap-1">
        {overview.overAlertLine.map((member) => (
          <li key={`${member.memberId}/${member.period}`}>
            {member.name} · {periodAdjectiveOf(member.period)} · {formatCost(member.spentMicros)} of{' '}
            {formatCost(member.limitMicros ?? 0)} ({member.percent}%)
          </li>
        ))}
      </ul>
    </LabelledSection>
  )

export const BudgetsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  const [overview, setOverview] = useState<BudgetOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    commands.readBudgets({ workspaceId }).then(setOverview, (error: unknown) => setLoadError(failureMessageOf(error)))
  }, [commands, workspaceId])
  const saveOf = (roleId: string) => async (dollars: Readonly<Record<BudgetPeriod, number | null>>) =>
    setOverview(await commands.saveRoleBudget({ workspaceId, roleId, dollars }))
  return (
    <LabelledSection title="AI budgets">
      <div className="-mt-2 flex flex-col gap-1 text-sm text-muted">
        <p>
          Each member gets the budget of their role for themselves: a role's budget is per member, not shared by the
          members who hold it. A role's total is its budget per member × its number of members, and the workspace total
          is the sum of the roles' totals.
        </p>
        <p>
          Budgets are in dollars; days, weeks (from Monday) and months are in UTC. At 100% of any of their budgets, a
          member's prompts are refused until the period ends or the budget is raised. Leave a budget empty for no limit.
        </p>
      </div>
      {overview === null ? (
        loadError ? (
          <ErrorMessage message={loadError} />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )
      ) : (
        <>
          <OverAlertLine overview={overview} />
          <div className={`${cardClass} overflow-x-auto px-2 py-1`}>
            <table aria-label="AI budgets per role" className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className={`${cellClass} text-left font-medium`}>
                    Role
                  </th>
                  <th scope="col" className={`${cellClass} text-right font-medium`}>
                    Members
                  </th>
                  {budgetPeriods.map((period) => (
                    <th key={period} scope="col" className={`${cellClass} text-right font-medium`}>
                      {periodTitleOf(period)} per member ($)
                    </th>
                  ))}
                  <th scope="col" className={cellClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.roles.map((role) => (
                  <RoleBudgetRow key={role.roleId} role={role} onSave={saveOf(role.roleId)} />
                ))}
              </tbody>
              <tfoot>
                <WorkspaceTotalRow roles={overview.roles} />
              </tfoot>
            </table>
          </div>
        </>
      )}
    </LabelledSection>
  )
}
