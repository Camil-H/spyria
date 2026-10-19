import type { Transact } from '@hq/db/zero-queries'
import type { WorkspaceId, WorkspacePermission } from '@hq/kernel'
import type { SpendTransactor } from '../contracts/spend.ts'
import type { MergedPull, SpendCall, SpendCounts } from '../domain/spend.ts'
import { workspacePermissionsStatement } from './postgres-audit-log.ts'

const callsStatement = `
  select grouped.bucket, grouped.prompter_id as "prompterId",
    coalesce(member.display_name, grouped.prompter_id) as "prompterName", grouped.chat_id as "chatId",
    coalesce(chat.name, grouped.chat_id) as "chatName", chat.project_id as "projectId", project.name as "projectName",
    grouped.model, grouped.cost_micros as "costMicros", grouped.tokens, grouped.requests
  from (
    select to_char(date_trunc($4::text, call.called_at at time zone 'UTC'), 'YYYY-MM-DD') as bucket,
      call.prompter_id, call.chat_id, call.provider || '/' || call.model as model,
      sum(call.cost_micros)::float8 as cost_micros, sum(call.input_tokens + call.output_tokens)::float8 as tokens,
      count(*)::int as requests
    from model_calls call
    where call.workspace_id = $1 and call.called_at >= $2 and call.called_at < $3
      and ($5::text is null or call.prompter_id = $5)
    group by 1, 2, 3, 4
  ) grouped
  left join memberships member on member.workspace_id = $1 and member.user_id = grouped.prompter_id
  left join chats chat on chat.workspace_id = $1 and chat.id = grouped.chat_id
  left join projects project on project.workspace_id = $1 and project.id = chat.project_id`

const countsStatement = `
  select call.called_at >= $3 as "isCurrent", count(distinct call.prompter_id collate "C")::int as users,
    count(distinct call.session_id collate "C")::int as sessions,
    count(distinct call.turn_id collate "C")::int as turns, count(*)::int as requests,
    sum(call.input_tokens + call.output_tokens)::float8 as tokens, sum(call.cost_micros)::float8 as "costMicros"
  from model_calls call
  where call.workspace_id = $1 and call.called_at >= $2 and call.called_at < $4
    and ($5::text is null or call.prompter_id = $5)
  group by 1`

const mergedPullsStatement = `
  with changes as (
    select event.chat_id, event.created_at, event.payload->'step' as step,
      lag(event.payload->'step'->>'state') over (
        partition by event.chat_id, coalesce(event.payload->>'messageId', event.id) order by event.seq
      ) as previous_state
    from events event
    where event.workspace_id = $1 and event.created_at < $3
      and event.type in ('message.posted', 'message.step_changed')
      and (event.payload -> 'step' ->> 'type') = 'pull_request'
  )
  select merged.chat_id as "chatId", chat.name as "chatName", merged.step->>'repository' as repository,
    (merged.step->>'number')::int as number, coalesce(merged.step->>'title', '') as title,
    coalesce(merged.step->>'url', '') as url,
    coalesce((select sum(call.cost_micros) from model_calls call
      where call.workspace_id = $1 and call.chat_id = merged.chat_id and call.called_at < $3), 0)::float8 as "costMicros"
  from changes merged
  join chats chat on chat.workspace_id = $1 and chat.id = merged.chat_id
  where merged.step->>'state' = 'merged' and merged.previous_state is distinct from 'merged' and merged.created_at >= $2
  order by merged.created_at`

const noCounts: SpendCounts = { users: 0, sessions: 0, turns: 0, requests: 0, tokens: 0, costMicros: 0 }

export const createPostgresSpendTransactor = (transact: Transact, workspaceId: WorkspaceId): SpendTransactor => ({
  run: (work) =>
    transact(async (tx) => {
      const query = async <Row>(statement: string, parameters: unknown[]) =>
        [...(await tx.dbTransaction.query(statement, [workspaceId, ...parameters]))] as Row[]
      return work({
        permissions: async (memberId) =>
          (await query<{ permission: WorkspacePermission }>(workspacePermissionsStatement, [memberId])).map(
            (granted) => granted.permission,
          ),
        calls: (range, granularity, prompterId) =>
          query<SpendCall>(callsStatement, [range.from.toISOString(), range.to.toISOString(), granularity, prompterId]),
        counts: async ({ current, previous }, prompterId) => {
          const rows = await query<SpendCounts & { isCurrent: boolean }>(countsStatement, [
            previous.from.toISOString(),
            current.from.toISOString(),
            current.to.toISOString(),
            prompterId,
          ])
          const countsOf = (isCurrent: boolean) => {
            const { isCurrent: _, ...counts } = rows.find((row) => row.isCurrent === isCurrent) ?? {
              ...noCounts,
              isCurrent,
            }
            return counts
          }
          return { current: countsOf(true), previous: countsOf(false) }
        },
        mergedPulls: (range) =>
          query<MergedPull>(mergedPullsStatement, [range.from.toISOString(), range.to.toISOString()]),
      })
    }),
})
