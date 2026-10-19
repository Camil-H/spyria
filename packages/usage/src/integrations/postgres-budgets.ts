import type { Transact } from '@spyria/db/zero-queries'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import type { BudgetTransactor } from '../contracts/budgets.ts'
import { type BudgetUse, budgetAlertIdOf, budgetLabelOf, type MemberSpend } from '../domain/budgets.ts'
import { workspacePermissionsStatement } from './postgres-audit-log.ts'

const spentSince = (prompterCondition: string) => `coalesce((select sum(call.cost_micros) from model_calls call
  where call.workspace_id = $1 and call.called_at >= $2 and ${prompterCondition}), 0)::float8`

const usesStatement = `
  select budget.member_id as "memberId", budget.limit_micros::float8 as "limitMicros",
    ${spentSince('(budget.member_id is null or call.prompter_id = budget.member_id)')} as "spentMicros"
  from budgets budget
  where budget.workspace_id = $1 and ($3::text is null or budget.member_id is null or budget.member_id = $3)`

const memberSpendsStatement = `
  select member.user_id as "memberId", member.display_name as name, budget.limit_micros::float8 as "limitMicros",
    ${spentSince('call.prompter_id = member.user_id')} as "spentMicros"
  from memberships member
  left join budgets budget on budget.workspace_id = $1 and budget.member_id = member.user_id
  where member.workspace_id = $1 and member.removed_at is null and ($3::text is null or member.user_id = $3)
  order by member.display_name, member.user_id`

const recordAlertsStatement = `
  with inserted as (
    insert into budget_alerts (workspace_id, id, member_id, month, threshold, reached_at)
    select $1, alert.id, alert."memberId", $2, alert.threshold, now()
    from jsonb_to_recordset($3::jsonb) as alert(id text, "memberId" text, threshold int)
    on conflict do nothing
    returning member_id, threshold)
  insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
  select $1, gen_random_uuid()::text, 'budget.threshold_reached', null,
    jsonb_strip_nulls(jsonb_build_object('memberId', member_id, 'threshold', threshold, 'month', $2::text)), now()
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
        uses: (since, memberId) => query<BudgetUse>(usesStatement, [since.toISOString(), memberId]),
        memberSpends: (since, memberId) => query<MemberSpend>(memberSpendsStatement, [since.toISOString(), memberId]),
        workspaceSpentMicros: async (since) =>
          (
            await query<{ spentMicros: number }>(`select ${spentSince('true')} as "spentMicros"`, [since.toISOString()])
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
            `insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
             values ($1, $2, 'budget.changed', $3, $4::jsonb, now())`,
            [
              crypto.randomUUID(),
              actorId,
              JSON.stringify({
                ...(memberId && { memberId }),
                monthlyBudget: budgetLabelOf(limitMicros),
              }),
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
            ])
        },
      })
    }),
})
