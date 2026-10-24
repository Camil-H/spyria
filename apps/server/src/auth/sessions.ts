import type { ServerTransaction } from '@rocicorp/zero'
import type { Database } from '@spyria/db/postgres'
import { deleteAbandonedAttachments } from '@spyria/db/server-writes'
import type { WorkspaceId } from '@spyria/kernel'
import { displayNameFrom, domainOfEmail, normalizedEmail } from '@spyria/workspace/server'
import type { FindMember, SessionClaims } from './session-tokens.ts'

type LiveSession = SessionClaims & { createdAt: Date }

export const openSessions = (database: Database, userId: string, workspaceId?: string, issuer?: string) =>
  database.$client<LiveSession[]>`
    with opened as (
      insert into sessions (workspace_id, id, user_id, created_at, expires_at)
      select workspace_id, gen_random_uuid()::text, user_id, now(), now() + interval '7 days'
      from memberships where user_id = ${userId} and workspace_id = coalesce(${workspaceId ?? null}::text, workspace_id)
        and removed_at is null and (${issuer ?? null}::text is null or exists(
          select 1 from workspace_sso where workspace_sso.workspace_id = memberships.workspace_id
            and workspace_sso.issuer = ${issuer ?? ''}))
        and exists(select 1 from workspaces where workspaces.workspace_id = memberships.workspace_id
          and workspaces.deleted_at is null)
      returning workspace_id, id, user_id, created_at)
    select opened.workspace_id as "workspaceId", opened.user_id as "userId", opened.id as "sessionId",
      opened.created_at as "createdAt"
    from opened join workspaces using (workspace_id)
    order by workspaces.created_at`

export const findLiveSessions = async (database: Database, sessionIdByWorkspace: [string, string][]) =>
  sessionIdByWorkspace.length === 0
    ? []
    : database.$client<LiveSession[]>`
    select sessions.workspace_id as "workspaceId", sessions.user_id as "userId", sessions.id as "sessionId",
      sessions.created_at as "createdAt"
    from sessions join memberships using (workspace_id, user_id) join workspaces using (workspace_id)
    where memberships.removed_at is null and workspaces.deleted_at is null
      and (sessions.workspace_id, sessions.id) in (
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
    const [member] = await database.$client<{ hasLiveSession: boolean }[]>`
      select removed_at is null and exists(
        select 1 from sessions where sessions.workspace_id = memberships.workspace_id
          and sessions.user_id = memberships.user_id and sessions.id = ${sessionId} and sessions.expires_at > now()
      ) as "hasLiveSession"
      from memberships where workspace_id = ${workspaceId} and user_id = ${userId}
        and exists(select 1 from workspaces where workspaces.workspace_id = memberships.workspace_id
          and workspaces.deleted_at is null)`
    return member
  }

type Identity = {
  email: string
  name?: unknown
  issuer?: string
  subject?: string
  legacySubject?: string
  canBindByEmail?: boolean
  currentSubjectPattern?: string
}

export const signInUser = (database: Database, identity: Identity, isSso = false) => {
  const email = normalizedEmail(identity.email)
  const { issuer = '', subject = '', legacySubject = subject, currentSubjectPattern = null } = identity
  const bindsByEmail = !isSso || identity.canBindByEmail !== false
  return database.$client.begin(async (sql) => {
    const ssoWorkspaces = await sql<{ workspaceId: string; isVerified: boolean }[]>`
        select workspace_id as "workspaceId", verified_at is not null as "isVerified"
        from workspace_sso join sso_domains using (workspace_id)
        where issuer = ${issuer} and domain = ${domainOfEmail(email)}
          and workspace_id in (select workspace_id from workspaces where deleted_at is null)
          and (verified_at is not null or (select count(*) from workspaces where deleted_at is null) = 1)`
    const ssoWorkspaceIds = ssoWorkspaces.map(({ workspaceId }) => workspaceId)
    const verifiedWorkspaceIds = ssoWorkspaces
      .filter(({ isVerified }) => isVerified)
      .map(({ workspaceId }) => workspaceId)
    if (isSso && ssoWorkspaceIds.length === 0) return { email }
    const invitations = await sql<{ workspaceId: string; id: string; role: string }[]>`
      select workspace_id as "workspaceId", id, role from invitations
      where email = ${email} and revoked_at is null and accepted_at is null and expires_at > now()
        and (not ${isSso}::boolean or workspace_id = any(${ssoWorkspaceIds}::text[]))
        and workspace_id in (select workspace_id from workspaces where deleted_at is null)
        and ${bindsByEmail}::boolean for update`
    const [found] = isSso
      ? await sql<{ id: string }[]>`
          select id from (
            select user_id as id, 1 as rank from identities
            where issuer = ${issuer} and subject in (${subject}, ${legacySubject})
            union all
            select users.id, 2 from users join memberships on memberships.user_id = users.id
            where users.email = ${email} and memberships.removed_at is null and ${bindsByEmail}::boolean
              and memberships.workspace_id = any(${verifiedWorkspaceIds}::text[])
              and not exists(select 1 from identities where identities.workspace_id = memberships.workspace_id
                and identities.issuer = ${issuer} and identities.user_id = users.id
                and (${currentSubjectPattern}::text is null or identities.subject ~ ${currentSubjectPattern}))
            union all
            select id, 3 from users where email = ${email} and ${invitations.length > 0}::boolean
              and not exists(select 1 from identities where identities.user_id = users.id
                and identities.issuer = ${issuer}
                and (${currentSubjectPattern}::text is null or identities.subject ~ ${currentSubjectPattern}))
          ) as candidates order by rank limit 1`
      : await sql<{ id: string }[]>`select id from users where email = ${email}`
    if (!found && invitations.length === 0) return { email }
    if (!found && (await sql`select 1 from users where email = ${email}`).length > 0) return { email }
    const [user] = found
      ? [found]
      : await sql<
          { id: string }[]
        >`insert into users (id, email) values (${crypto.randomUUID()}, ${email}) returning id`
    const userId = user?.id ?? ''
    for (const invitation of invitations) {
      const joined = await sql`
        insert into memberships (workspace_id, user_id, role, display_name)
        values (${invitation.workspaceId}, ${userId}, ${invitation.role}, ${displayNameFrom({ ...identity, email })})
        on conflict (workspace_id, user_id) do update set role = excluded.role, removed_at = null
          where memberships.removed_at is not null
        returning user_id`
      await sql`update invitations set accepted_at = now() where workspace_id = ${invitation.workspaceId} and id = ${invitation.id}`
      if (joined.length > 0)
        await sql`
          insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
          values (${invitation.workspaceId}, ${crypto.randomUUID()}, 'member.joined', ${userId},
            ${JSON.stringify({ memberId: userId, role: invitation.role, invitationId: invitation.id })}::jsonb, now())`
    }
    if (isSso)
      await sql`
        insert into identities (workspace_id, issuer, subject, user_id)
        select workspace_id, ${issuer}, ${subject}, user_id from memberships
        where user_id = ${userId} and removed_at is null and workspace_id = any(${ssoWorkspaceIds}::text[])
        on conflict do nothing`
    return { userId, email }
  })
}

const enqueueSweepStatement = `
  insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
  select workspace_id, gen_random_uuid()::text, type, '{}'::jsonb, now() + $2::interval, 0, 'queued'
  from workspaces cross join unnest($3::text[]) as type where workspace_id = coalesce($1::text, workspace_id)
    and deleted_at is null
  on conflict do nothing`

export const recurringJobTypes = ['sessions.sweep', 'runtime.sweep', 'agent.sweep', 'usage.sync', 'audit.sweep']

export const enqueueSweeps = (database: Database, workspaceId: string | null = null) =>
  database.$client.unsafe(enqueueSweepStatement, [workspaceId, '0 seconds', recurringJobTypes])

export const sessionJobs = {
  'sessions.sweep': async (tx: ServerTransaction, workspaceId: WorkspaceId) => {
    await tx.dbTransaction.query('delete from sessions where workspace_id = $1 and expires_at < now()', [workspaceId])
    await tx.dbTransaction.query(
      `delete from jobs where workspace_id = $1 and state = 'done' and run_at < now() - interval '1 day'`,
      [workspaceId],
    )
    await tx.dbTransaction.query(
      `delete from github_webhook_deliveries where workspace_id = $1 and received_at < now() - interval '7 days'`,
      [workspaceId],
    )
    await deleteAbandonedAttachments(tx, workspaceId)
    await tx.dbTransaction.query(enqueueSweepStatement, [workspaceId, '1 day', ['sessions.sweep']])
  },
}
