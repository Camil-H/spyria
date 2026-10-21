import type { Transact } from '@spyria/db/zero-queries'
import type { WorkspaceId } from '@spyria/kernel'
import type { UsageLedger } from '../contracts/usage-sync.ts'
import { usageJobTypes } from '../domain/usage.ts'

const recordCalls = `
  with incoming as (
    select * from jsonb_to_recordset($2::jsonb) as call(
      id text, "chatId" text, "prompterId" text, "ownerId" text, model text, provider text,
      "inputTokens" int, "outputTokens" int, "costMicros" int, status text, role text, "turnId" text,
      "sessionId" text, "calledAt" timestamptz)
  ), inserted as (
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider,
      input_tokens, output_tokens, cost_micros, status, role, turn_id, session_id, called_at)
    select $1, id, "chatId", "prompterId", "ownerId", model, provider,
      "inputTokens", "outputTokens", "costMicros", status, role, "turnId", "sessionId", "calledAt" from incoming
    on conflict do nothing
    returning *)
  insert into usage_entries (workspace_id, month, chat_id, user_id, tokens, cost_micros, calls)
  select workspace_id, to_char(called_at at time zone 'UTC', 'YYYY-MM'), chat_id, prompter_id,
    sum(input_tokens + output_tokens), sum(cost_micros), count(*)
  from inserted
  where exists (select 1 from chats where chats.workspace_id = inserted.workspace_id and chats.id = inserted.chat_id)
    and exists (select 1 from memberships
      where memberships.workspace_id = inserted.workspace_id and memberships.user_id = inserted.prompter_id)
  group by 1, 2, 3, 4
  on conflict (workspace_id, month, chat_id, user_id) do update set
    tokens = usage_entries.tokens + excluded.tokens,
    cost_micros = usage_entries.cost_micros + excluded.cost_micros,
    calls = usage_entries.calls + excluded.calls`

export const createPostgresUsageLedger = (transact: Transact): UsageLedger => ({
  logsSince: (workspaceId) =>
    transact(async (tx) => {
      const [mark] = await tx.dbTransaction.query(
        'select logs_since as "logsSince" from usage_sync_marks where workspace_id = $1',
        [workspaceId],
      )
      return mark && new Date((mark as { logsSince: string | Date }).logsSince)
    }),
  record: (workspaceId, { readFrom, nextLogsSince }, calls) =>
    transact(async (tx) => {
      const moved = await tx.dbTransaction.query(
        `insert into usage_sync_marks (workspace_id, logs_since) values ($1, $2::timestamptz)
         on conflict (workspace_id) do update set logs_since = excluded.logs_since
         where $3::timestamptz is not null and date_trunc('milliseconds', usage_sync_marks.logs_since) = $3::timestamptz
         returning 1`,
        [workspaceId, nextLogsSince.toISOString(), readFrom?.toISOString() ?? null],
      )
      if ([...moved].length === 0) return false
      await tx.dbTransaction.query(recordCalls, [workspaceId, JSON.stringify(calls)])
      return true
    }),
  scheduleNextSync: (workspaceId: WorkspaceId, delayMilliseconds) =>
    transact(async (tx) => {
      await tx.dbTransaction.query(
        `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
         values ($1, gen_random_uuid()::text, $2, '{}'::jsonb,
           now() + make_interval(secs => $3::double precision / 1000), 0, 'queued')
         on conflict do nothing`,
        [workspaceId, usageJobTypes.sync, delayMilliseconds],
      )
    }),
})
