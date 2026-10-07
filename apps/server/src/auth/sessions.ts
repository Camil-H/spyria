import type { Database } from '@hq/db/postgres'
import type { WorkspaceId } from '@hq/kernel'
import type { ServerTransaction } from '@rocicorp/zero'
import type { FindMember, SessionClaims } from './session-tokens.ts'

type LiveSession = SessionClaims & { createdAt: Date }

export const openSessions = (database: Database, userId: string, workspaceId?: string) =>
  database.$client<LiveSession[]>`
    with opened as (
      insert into sessions (workspace_id, id, user_id, created_at, expires_at)
      select workspace_id, gen_random_uuid()::text, user_id, now(), now() + interval '7 days'
      from memberships where user_id = ${userId} and workspace_id = coalesce(${workspaceId ?? null}::text, workspace_id)
      returning workspace_id, id, user_id, created_at)
    select opened.workspace_id as "workspaceId", opened.user_id as "userId", opened.id as "sessionId",
      memberships.role, opened.created_at as "createdAt"
    from opened join memberships using (workspace_id, user_id) join workspaces using (workspace_id)
    order by workspaces.created_at`

export const findLiveSessions = async (database: Database, sessionIdByWorkspace: [string, string][]) =>
  sessionIdByWorkspace.length === 0
    ? []
    : database.$client<LiveSession[]>`
    select sessions.workspace_id as "workspaceId", sessions.user_id as "userId", sessions.id as "sessionId",
      memberships.role, sessions.created_at as "createdAt"
    from sessions join memberships using (workspace_id, user_id) join workspaces using (workspace_id)
    where (sessions.workspace_id, sessions.id) in (
        select * from unnest(${sessionIdByWorkspace.map(([workspaceId]) => workspaceId)}::text[],
          ${sessionIdByWorkspace.map(([, sessionId]) => sessionId)}::text[]))
      and sessions.expires_at > now()
    order by workspaces.created_at`

export const deleteSession = (database: Database, workspaceId: string, sessionId: string) =>
  database.$client`delete from sessions where workspace_id = ${workspaceId} and id = ${sessionId}`

export const findMemberIn =
  (databaseOf: (databaseName: string | undefined) => Database | undefined): FindMember =>
  async ({ workspaceId, userId, sessionId }, databaseName) => {
    const database = databaseOf(databaseName)
    if (!database) return undefined
    const [member] = await database.$client<{ role: SessionClaims['role']; hasLiveSession: boolean }[]>`
      select role, exists(
        select 1 from sessions where sessions.workspace_id = memberships.workspace_id
          and sessions.user_id = memberships.user_id and sessions.id = ${sessionId} and sessions.expires_at > now()
      ) as "hasLiveSession"
      from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`
    return member
  }

const enqueueSweepStatement = `
  insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
  select workspace_id, gen_random_uuid()::text, type, '{}'::jsonb, now() + $2::interval, 0, 'queued'
  from workspaces cross join unnest($3::text[]) as type where workspace_id = coalesce($1::text, workspace_id)
  on conflict do nothing`

export const enqueueSweeps = (database: Database) =>
  database.$client.unsafe(enqueueSweepStatement, [
    null,
    '0 seconds',
    ['sessions.sweep', 'runtime.sweep', 'agent.sweep', 'usage.sync'],
  ])

export const sessionJobs = {
  'sessions.sweep': async (tx: ServerTransaction, workspaceId: WorkspaceId) => {
    await tx.dbTransaction.query('delete from sessions where workspace_id = $1 and expires_at < now()', [workspaceId])
    await tx.dbTransaction.query(enqueueSweepStatement, [workspaceId, '1 day', ['sessions.sweep']])
  },
}
