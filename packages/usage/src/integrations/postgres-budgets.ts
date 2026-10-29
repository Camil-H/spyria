import type { Transact } from '@spyria/db/zero-queries'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import type { BudgetTransactor } from '../contracts/budgets.ts'
import { type BudgetUse, budgetAlertIdOf, budgetLabelOf, type MemberSpend } from '../domain/budgets.ts'
import { workspacePermissionsStatement } from './postgres-audit-log.ts'

const monthSpends = `spends as (
  select entry.user_id, sum(entry.cost_micros) as cost_micros from usage_entries entry
  where entry.workspace_id = $1 and entry.month = $2 group by entry.user_id)`

const usesStatement = `
  with ${monthSpends}
  select budget.member_id as "memberId", budget.limit_micros::float8 as "limitMicros",
    coalesce(case when budget.member_id is null then (select sum(cost_micros) from spends) else spend.cost_micros end,
      0)::float8 as "spentMicros"
  from budgets budget
  left join spends spend on spend.user_id = budget.member_id
  where budget.workspace_id = $1 and ($3::text is null or budget.member_id is null or budget.member_id = $3)`

const memberSpendsStatement = `
  with ${monthSpends}
  select member.user_id as "memberId", member.display_name as name, budget.limit_micros::float8 as "limitMicros",
    coalesce(spend.cost_micros, 0)::float8 as "spentMicros"
  from memberships member
  left join budgets budget on budget.workspace_id = $1 and budget.member_id = member.user_id
  left join spends spend on spend.user_id = member.user_id
  where member.workspace_id = $1 and member.removed_at is null and ($3::text is null or member.user_id = $3)
  order by member.display_name, member.user_id`

const recordAlertsStatement = `
  with inserted as (
    insert into budget_alerts (workspace_id, id, member_id, month, threshold, reached_at)
    select $1, alert.id, alert."memberId", $2, alert.threshold, $4::timestamptz
    from jsonb_to_recordset($3::jsonb) as alert(id text, "memberId" text, threshold int)
    on conflict do nothing
    returning member_id, threshold)
  insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, payload, created_at)
  select $1, gen_random_uuid()::text, 'budget.threshold_reached', 'system', 'budget.alerts',
    jsonb_strip_nulls(jsonb_build_object('memberId', member_id, 'threshold', threshold, 'month', $2::text)), $4::timestamptz
  from inserted`

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
        uses: (month, memberId) => query<BudgetUse>(usesStatement, [month, memberId]),
        memberSpends: (month, memberId) => query<MemberSpend>(memberSpendsStatement, [month, memberId]),
        workspaceSpentMicros: async (month) =>
          (
            await query<{ spentMicros: number }>(
              `with ${monthSpends} select coalesce(sum(cost_micros), 0)::float8 as "spentMicros" from spends`,
              [month],
            )
          )[0]?.spentMicros ?? 0,
        setBudget: async ({ memberId, limitMicros }, actorId) => {
          await query(
            limitMicros === null
              ? 'delete from budgets where workspace_id = $1 and member_id is not distinct from $2'
              : `insert into budgets (workspace_id, member_id, limit_micros) values ($1, $2, $3)
                 on conflict (workspace_id, member_id) do update set limit_micros = excluded.limit_micros`,
            limitMicros === null ? [memberId] : [memberId, limitMicros],
          )
          await query(
            `insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, payload, created_at)
             values ($1, $2, 'budget.changed', 'member', $3, $4::jsonb, $5::timestamptz)`,
            [
              crypto.randomUUID(),
              actorId,
              JSON.stringify({
                ...(memberId && { memberId }),
                monthlyBudget: budgetLabelOf(limitMicros),
              }),
              new Date().toISOString(),
            ],
          )
        },
        clearAlerts: async (memberId, month) => {
          await query(
            'delete from budget_alerts where workspace_id = $1 and month = $2 and member_id is not distinct from $3',
            [month, memberId],
          )
        },
        recordAlerts: async (month, alerts) => {
          if (alerts.length > 0)
            await query(recordAlertsStatement, [
              month,
              JSON.stringify(alerts.map((alert) => ({ ...alert, id: budgetAlertIdOf(month, alert) }))),
              new Date().toISOString(),
            ])
        },
      })
    }),
})
