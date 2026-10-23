import type { Database } from '@spyria/db/postgres'
import { workspaceCleanupJobTypes, workspaceHaltJobType, workspacePurgeJobType } from '@spyria/db/server-writes'
import { enqueueSweeps } from './auth/sessions.ts'

export const restoreWorkspace = async (database: Database, workspaceId: string) => {
  const restored = await database.$client.begin(async (sql) => {
    const [workspace] = await sql`
      update workspaces set deleted_at = null, purge_at = null
      where workspace_id = ${workspaceId} and deleted_at is not null and purge_at > now()
      returning workspace_id`
    if (!workspace) return false
    await sql`delete from jobs where workspace_id = ${workspaceId} and type = ${workspacePurgeJobType}`
    await sql`
      insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
      values (${workspaceId}, ${crypto.randomUUID()}, 'workspace.restored', 'operator', '{}'::jsonb, now())`
    return true
  })
  if (!restored) throw new Error(`Workspace ${workspaceId} is not scheduled for deletion, or its purge has started`)
  await enqueueSweeps(database, workspaceId)
}

export const purgeWorkspaceNow = async (database: Database, workspaceId: string) => {
  const purged = await database.$client.begin(async (sql) => {
    const [workspace] = await sql`
      update workspaces set purge_at = now() where workspace_id = ${workspaceId} and deleted_at is not null
      returning workspace_id`
    if (workspace)
      await sql`
        update jobs set run_at = now() where workspace_id = ${workspaceId} and state = 'queued'
          and type in (${workspacePurgeJobType}, ${workspaceHaltJobType})`
    return workspace !== undefined
  })
  if (!purged) throw new Error(`Workspace ${workspaceId} is not scheduled for deletion`)
}

export const abandonFailedCleanup = async (database: Database, workspaceId: string) =>
  database.$client<{ type: string; lastError: string | null }[]>`
    delete from jobs using workspaces
    where jobs.workspace_id = ${workspaceId} and workspaces.workspace_id = jobs.workspace_id
      and workspaces.deleted_at is not null and jobs.state = 'failed'
      and jobs.type = any(${[...workspaceCleanupJobTypes]}::text[])
    returning jobs.type, jobs.last_error as "lastError"`
