import type { Database } from '@hq/db/postgres'
import type { FindMember, SessionClaims } from './session-tokens.ts'

export type LiveSession = SessionClaims & { createdAt: Date }

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

export const findLiveSessions = (database: Database, sessionIdByWorkspace: [string, string][]) =>
  database.$client<LiveSession[]>`
    select sessions.workspace_id as "workspaceId", sessions.user_id as "userId", sessions.id as "sessionId",
      memberships.role, sessions.created_at as "createdAt"
    from sessions join memberships using (workspace_id, user_id) join workspaces using (workspace_id)
    where sessions.workspace_id || '/' || sessions.id = any(${sessionIdByWorkspace.map((pair) => pair.join('/'))}::text[])
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
