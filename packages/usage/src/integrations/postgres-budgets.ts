import type { Transact } from '@spyria/db/zero-queries'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import type { BudgetTransactor } from '../contracts/budgets.ts'
import {
  type BudgetLimits,
  budgetAlertIdOf,
  budgetLabelOf,
  budgetPeriods,
  type MemberPeriodSpend,
  periodAdjectiveOf,
  type RoleBudget,
} from '../domain/budgets.ts'
import { workspacePermissionsStatement } from './postgres-audit-log.ts'

const roleBudgetsStatement = `
  select role.id as "roleId", role.name,
    (select count(*) from memberships member
      where member.workspace_id = $1 and member.role = role.id and member.removed_at is null)::int as "memberCount",
    coalesce((select jsonb_object_agg(budget.period, budget.limit_micros) from role_budgets budget
      where budget.workspace_id = $1 and budget.role_id = role.id), '{}'::jsonb) as limits
  from workspace_roles role
  where role.workspace_id = $1
  order by role.built_in desc, lower(role.name), role.id`

const memberSpendsStatement = `
  with periods as (
    select * from jsonb_to_recordset($2::jsonb) as period(period text, "startsAt" timestamptz)),
  members as (
    select member.user_id, member.display_name, member.role from memberships member
    where member.workspace_id = $1 and member.removed_at is null
      and (member.user_id = $3 or $3::text is null and exists (select 1 from role_budgets budget
        where budget.workspace_id = $1 and budget.role_id = member.role))),
  spends as (
    select call.prompter_id, period.period, sum(call.cost_micros) as cost_micros
    from model_calls call
    join periods period on call.called_at >= period."startsAt"
    where call.workspace_id = $1 and call.called_at >= (select min("startsAt") from periods)
      and call.prompter_id in (select user_id from members)
    group by call.prompter_id, period.period)
  select member.user_id as "memberId", member.display_name as name, period.period,
    budget.limit_micros::float8 as "limitMicros", coalesce(spend.cost_micros, 0)::float8 as "spentMicros"
  from members member
  cross join periods period
  left join role_budgets budget on budget.workspace_id = $1 and budget.role_id = member.role
    and budget.period = period.period
  left join spends spend on spend.prompter_id = member.user_id and spend.period = period.period
  order by member.display_name, member.user_id, array_position(array['day', 'week', 'month'], period.period)`

const recordAlertsStatement = `
  with inserted as (
    insert into budget_alerts (workspace_id, id, member_id, period, starts_on, threshold, reached_at)
    select $1, alert.id, alert."memberId", alert.period, alert."startsOn", alert.threshold, $3::timestamptz
    from jsonb_to_recordset($2::jsonb) as alert(id text, "memberId" text, period text, "startsOn" text, threshold int)
    on conflict do nothing
    returning member_id, period, starts_on, threshold)
  insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, payload, created_at)
  select $1, gen_random_uuid()::text, 'budget.threshold_reached', 'system', 'budget.alerts',
    jsonb_build_object('memberId', member_id, 'threshold', threshold, 'period', period, 'startsOn', starts_on),
    $3::timestamptz
  from inserted`

const clearRoleAlertsStatement = `
  delete from budget_alerts alert
  using memberships member, jsonb_to_recordset($3::jsonb) as cleared(period text, "startsOn" text)
  where alert.workspace_id = $1 and member.workspace_id = $1 and member.user_id = alert.member_id
    and member.role = $2 and alert.period = cleared.period and alert.starts_on = cleared."startsOn"`

const limitsOf = (stored: Readonly<Record<string, number>>) =>
  Object.fromEntries(budgetPeriods.map((period) => [period, stored[period] ?? null])) as BudgetLimits

export const createPostgresBudgetTransactor = (transact: Transact, workspaceId: WorkspaceId): BudgetTransactor => ({
  run: (work) =>
    transact(async (tx) => {
      const query = async <Row>(statement: string, parameters: unknown[]) =>
        [...(await tx.dbTransaction.query(statement, [workspaceId, ...parameters]))] as Row[]
      return work({
        permissions: async (memberId) =>
          (await query<{ permission: WorkspacePermission }>(workspacePermissionsStatement, [memberId])).map(
            (granted) => granted.permission,
          ),
        roleBudgets: async () =>
          (await query<Omit<RoleBudget, 'limits'> & { limits: Record<string, number> }>(roleBudgetsStatement, [])).map(
            (role) => ({ ...role, limits: limitsOf(role.limits) }),
          ),
        memberSpends: (periodStarts, memberId) =>
          query<MemberPeriodSpend>(memberSpendsStatement, [
            JSON.stringify(budgetPeriods.map((period) => ({ period, startsAt: periodStarts[period].toISOString() }))),
            memberId,
          ]),
        setRoleBudget: async ({ roleId, limits }, changedPeriods, actorId) => {
          for (const period of changedPeriods) {
            const limitMicros = limits[period]
            await query(
              limitMicros === null
                ? 'delete from role_budgets where workspace_id = $1 and role_id = $2 and period = $3'
                : `insert into role_budgets (workspace_id, role_id, period, limit_micros) values ($1, $2, $3, $4)
                   on conflict (workspace_id, role_id, period) do update set limit_micros = excluded.limit_micros`,
              limitMicros === null ? [roleId, period] : [roleId, period, limitMicros],
            )
          }
          await query(
            `insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, payload, created_at)
             values ($1, $2, 'budget.changed', 'member', $3, $4::jsonb, $5::timestamptz)`,
            [
              crypto.randomUUID(),
              actorId,
              JSON.stringify({
                role: roleId,
                ...Object.fromEntries(
                  changedPeriods.map((period) => [
                    `${periodAdjectiveOf(period)}BudgetPerMember`,
                    budgetLabelOf(limits[period]),
                  ]),
                ),
              }),
              new Date().toISOString(),
            ],
          )
        },
        clearRoleAlerts: async (roleId, periods) => {
          await query(clearRoleAlertsStatement, [roleId, JSON.stringify(periods)])
        },
        recordAlerts: async (alerts) => {
          if (alerts.length > 0)
            await query(recordAlertsStatement, [
              JSON.stringify(alerts.map((alert) => ({ ...alert, id: budgetAlertIdOf(alert) }))),
              new Date().toISOString(),
            ])
        },
      })
    }),
})
