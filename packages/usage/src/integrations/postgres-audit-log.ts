import type { Transact } from '@hq/db/zero-queries'
import type { WorkspaceId } from '@hq/kernel'
import type { AuditQuery, AuditTransactor } from '../contracts/audit-log.ts'
import { type AuditRecord, auditJobTypes } from '../domain/audit.ts'

const pageOf = (branch: string) => `(select * from (${branch}) branch
  where ($2::timestamptz is null or branch.at <= $2 and (branch.at, branch.key) < ($2, $3::text))
    and ($4::timestamptz is null or branch.at >= $4)
    and ($5::timestamptz is null or branch.at < $5)
    and ($6::text is null or branch.actor_id = $6)
    and ($7::text[] is null or branch.kind = any($7))
  order by branch.at desc, branch.key desc limit $8)`

const memberNamed = (alias: string, idExpression: string) =>
  `left join memberships ${alias} on ${alias}.workspace_id = $1 and ${alias}.user_id = ${idExpression}`
const chatNamed = (alias: string, idExpression: string) =>
  `left join chats ${alias} on ${alias}.workspace_id = $1 and ${alias}.id = ${idExpression}`

const workspaceEventRecords = `
  select event.created_at as at, 'w:' || event.id as key, event.type as kind, event.actor_id,
    case
      when event.type like 'connection.%' then coalesce(event.payload->>'name', connection.name)
      when event.type = 'chat.transferred' then chat.name
      when event.type like 'budget.%' then coalesce(member.display_name, 'Workspace total')
      when event.payload ? 'memberId' then member.display_name
      else coalesce(event.payload->>'email', event.payload->>'domain', event.payload->>'issuer', event.payload->>'appId')
    end as target,
    jsonb_strip_nulls((event.payload - 'memberId' - 'chatId' - 'connectionId' - 'invitationId' - 'fromId' - 'toId')
      || jsonb_build_object('member', member.display_name, 'chat', chat.name, 'from', from_member.display_name,
        'to', to_member.display_name))::json as details
  from workspace_events event
  ${memberNamed('member', "event.payload->>'memberId'")}
  ${memberNamed('from_member', "event.payload->>'fromId'")}
  ${memberNamed('to_member', "event.payload->>'toId'")}
  ${chatNamed('chat', "event.payload->>'chatId'")}
  left join workspace_connections connection on connection.workspace_id = $1
    and connection.id = event.payload->>'connectionId'
  where event.workspace_id = $1`

const chatEventRecords = `
  select event.created_at as at, 'c:' || event.id as key,
    case when event.type like 'member.%' then 'chat.' || event.type
      when event.type = 'chat.created' then 'chat.forked' else event.type end as kind,
    event.actor as actor_id, chat.name as target,
    json_build_object('member', member.display_name, 'role', role.name,
      'visibility', event.payload->>'visibility', 'fromChat', origin.name, 'branch', event.payload->>'branch',
      'head', event.payload->>'head') as details
  from events event
  join chats chat on chat.workspace_id = event.workspace_id and chat.id = event.chat_id
  ${memberNamed('member', "event.payload->>'memberId'")}
  ${chatNamed('origin', "event.payload->>'originChatId'")}
  left join chat_roles role on role.workspace_id = $1 and role.id = event.payload->>'roleId'
  where event.workspace_id = $1
    and event.type in ('member.invited', 'member.joined', 'member.role_changed', 'member.removed', 'member.left',
      'chat.visibility_changed', 'chat.created', 'branch.pushed')
    and (event.type <> 'chat.created' or event.payload ? 'originChatId')`

const toolCallRecords = `
  select call.called_at as at, 't:' || call.id as key, 'tool.called' as kind, call.prompter_id as actor_id,
    call.server || ' · ' || call.tool as target,
    json_build_object('chat', chat.name, 'server', call.server, 'tool', call.tool,
      'readOnly', call.read_only, 'decision', replace(call.decision, '_', ' '), 'decidedBy', decider.display_name,
      'owner', owner.display_name, 'status', call.status) as details
  from tool_calls call
  ${chatNamed('chat', 'call.chat_id')}
  ${memberNamed('decider', 'call.decided_by')}
  ${memberNamed('owner', 'call.owner_id')}
  where call.workspace_id = $1`

const pullRequestRecords = `
  select change.at, change.key,
    case when change.type = 'message.posted' then 'pull_request.opened'
      else 'pull_request.' || (change.step->>'state') end as kind,
    change.actor_id, (change.step->>'repository') || '#' || (change.step->>'number') as target,
    json_build_object('chat', change.chat_name, 'title', change.step->>'title',
      'state', change.step->>'state', 'url', change.step->>'url') as details
  from (
    select event.created_at as at, 'c:' || event.id as key, event.type, event.actor as actor_id,
      chat.name as chat_name, event.payload->'step' as step,
      lag(event.payload->'step'->>'state') over (
        partition by event.chat_id, coalesce(event.payload->>'messageId', event.id) order by event.seq
      ) as previous_state
    from events event
    join chats chat on chat.workspace_id = event.workspace_id and chat.id = event.chat_id
    where event.workspace_id = $1 and event.type in ('message.posted', 'message.step_changed')
      and (event.payload -> 'step' ->> 'type') = 'pull_request'
  ) change
  where change.type = 'message.posted' or change.step->>'state' is distinct from change.previous_state`

export const activeAdminStatement = `select 1 from memberships where workspace_id = $1 and user_id = $2
  and role = 'admin' and removed_at is null`

const auditRecordsStatement = `
  select to_char(page.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, page.key, page.kind,
    page.actor_id as "actorId", actor.display_name as "actorName", page.target, page.details
  from (${[workspaceEventRecords, chatEventRecords, toolCallRecords, pullRequestRecords].map(pageOf).join(' union all ')}) page
  ${memberNamed('actor', 'page.actor_id')}
  order by page.at desc, page.key desc limit $8`

export const createPostgresAuditTransactor = (transact: Transact, workspaceId: WorkspaceId): AuditTransactor => ({
  run: (work) =>
    transact(async (tx) => {
      const query = async <Row>(statement: string, parameters: unknown[]) =>
        [...(await tx.dbTransaction.query(statement, [workspaceId, ...parameters]))] as Row[]
      const retentionDays = async () =>
        (
          await query<{ retentionDays: number | null }>(
            'select retention_days as "retentionDays" from audit_settings where workspace_id = $1',
            [],
          )
        )[0]?.retentionDays ?? null
      return work({
        isActiveAdmin: async (memberId) => (await query(activeAdminStatement, [memberId])).length > 0,
        records: async ({ since, until, personId, kinds, before, limit }: AuditQuery) =>
          query<AuditRecord>(auditRecordsStatement, [
            before?.at ?? null,
            before?.key ?? null,
            since?.toISOString() ?? null,
            until?.toISOString() ?? null,
            personId,
            kinds,
            limit,
          ]),
        retentionDays,
        setRetentionDays: async (days, actorId) => {
          await query(
            `insert into audit_settings (workspace_id, retention_days) values ($1, $2)
             on conflict (workspace_id) do update set retention_days = excluded.retention_days`,
            [days],
          )
          await query(
            `insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
             values ($1, $2, 'audit.retention_changed', $3, $4::jsonb, now())`,
            [crypto.randomUUID(), actorId, JSON.stringify({ retentionDays: days })],
          )
        },
        deleteRecordsOlderThan: async (days) => {
          for (const statement of [
            'delete from workspace_events where workspace_id = $1 and created_at < now() - make_interval(days => $2)',
            'delete from tool_calls where workspace_id = $1 and called_at < now() - make_interval(days => $2)',
          ])
            await query(statement, [days])
        },
        scheduleSweep: async (delayMilliseconds) => {
          await query(
            `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
             values ($1, gen_random_uuid()::text, $2, '{}'::jsonb,
               now() + make_interval(secs => $3::double precision / 1000), 0, 'queued')
             on conflict do nothing`,
            [auditJobTypes.sweep, delayMilliseconds],
          )
        },
      })
    }),
})
