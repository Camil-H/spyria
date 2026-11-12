import type { ServerTransaction } from '@rocicorp/zero'
import type { Database } from '@spyria/db/postgres'
import { deleteAbandonedAttachments } from '@spyria/db/server-writes'
import type { WorkspaceId } from '@spyria/kernel'
import { AccountBoundElsewhere, displayNameFrom, normalizedEmail } from '@spyria/workspace/server'
import type { FindMember, SessionClaims } from './session-tokens.ts'

type LiveSession = SessionClaims & { createdAt: Date }
export type SignedInThrough = 'account' | 'workspace sso'
export type Sql = Parameters<Parameters<Database['$client']['begin']>[1]>[0]

export const openSessions = (
  database: Database,
  userId: string,
  workspaceId?: string,
  through: SignedInThrough = 'account',
  userAgent = '',
  signedInAt?: Date,
) =>
  database.$client<LiveSession[]>`
    with opened as (
      insert into sessions (workspace_id, id, user_id, opened_through_workspace_sso, user_agent, signed_in_at,
        created_at, expires_at)
      select workspace_id, gen_random_uuid()::text, user_id, ${through === 'workspace sso'}, ${userAgent},
        coalesce(${signedInAt ?? null}::timestamptz, now()), now(), now() + interval '7 days'
      from memberships where user_id = ${userId} and workspace_id = coalesce(${workspaceId ?? null}::text, workspace_id)
        and removed_at is null
        and exists(select 1 from workspace_sso where workspace_sso.workspace_id = memberships.workspace_id)
          = ${through === 'workspace sso'}
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
      and sessions.opened_through_workspace_sso = exists(select 1 from workspace_sso
        where workspace_sso.workspace_id = sessions.workspace_id)
    order by workspaces.created_at`

export const deleteSession = (database: Database, workspaceId: string, sessionId: string) =>
  database.$client`delete from sessions where workspace_id = ${workspaceId} and id = ${sessionId}`

export const findMemberSessions = (database: Database, workspaceId: string, userId: string) =>
  database.$client<{ sessionId: string; userAgent: string; createdAt: Date }[]>`
    select id as "sessionId", user_agent as "userAgent", created_at as "createdAt" from sessions
    where workspace_id = ${workspaceId} and user_id = ${userId} and expires_at > now()
    order by created_at desc`

export const signOutMemberEverywhere = (database: Database, workspaceId: string, userId: string) =>
  database.$client`
    with ended as (delete from sessions where workspace_id = ${workspaceId} and user_id = ${userId})
    insert into member_sign_outs (workspace_id, user_id, signed_out_at) values (${workspaceId}, ${userId}, now())
    on conflict (workspace_id, user_id) do update set signed_out_at = excluded.signed_out_at`

export const signedInAtOf = async (database: Database, { workspaceId, sessionId }: SessionClaims) => {
  const [session] = await database.$client<{ signedInAt: Date }[]>`
    select signed_in_at as "signedInAt" from sessions where workspace_id = ${workspaceId} and id = ${sessionId}`
  return session?.signedInAt
}

export const isSignedOutSince = async (database: Database, workspaceId: string, userId: string, signedInAt: Date) => {
  const [signedOut] = await database.$client`
    select 1 from member_sign_outs where workspace_id = ${workspaceId} and user_id = ${userId}
      and signed_out_at >= ${signedInAt}`
  return signedOut !== undefined
}

export const findMemberIn =
  (databaseOf: (databaseName: string | undefined) => Database | undefined): FindMember =>
  async ({ workspaceId, userId, sessionId }, databaseName) => {
    const database = databaseOf(databaseName)
    if (!database) return undefined
    const [member] = await database.$client<{ hasLiveSession: boolean; signedInThroughWorkspaceSso: boolean }[]>`
      select removed_at is null and coalesce(session.opened_through_workspace_sso = exists(
          select 1 from workspace_sso where workspace_sso.workspace_id = memberships.workspace_id), false)
          as "hasLiveSession",
        coalesce(session.opened_through_workspace_sso, false) as "signedInThroughWorkspaceSso"
      from memberships left join lateral (
        select opened_through_workspace_sso from sessions where sessions.workspace_id = memberships.workspace_id
          and sessions.user_id = memberships.user_id and sessions.id = ${sessionId} and sessions.expires_at > now()
      ) as session on true
      where workspace_id = ${workspaceId} and user_id = ${userId}
        and exists(select 1 from workspaces where workspaces.workspace_id = memberships.workspace_id
          and workspaces.deleted_at is null)`
    return member
  }

export type VerifiedIdentity = {
  email: string
  name?: unknown
  issuer: string
  subject: string
  legacySubject?: string
  canBindByEmail: boolean
}
export type WorkspaceSignIn = { workspaceId: string; issuer: string; currentSubjectPattern?: string }

const joinInvitedWorkspaces = async (
  sql: Sql,
  { userId, email, name, workspaceId }: { userId: string; email: string; name?: unknown; workspaceId: string | null },
) => {
  const invitations = await sql<{ workspaceId: string; id: string; role: string }[]>`
    select workspace_id as "workspaceId", id, role from invitations
    where email = ${email} and revoked_at is null and accepted_at is null and expires_at > now()
      and workspace_id in (select workspace_id from workspaces where deleted_at is null)
      and case when ${workspaceId}::text is null
        then not exists(select 1 from workspace_sso where workspace_sso.workspace_id = invitations.workspace_id)
        else invitations.workspace_id = ${workspaceId} end
    for update`
  for (const invitation of invitations) {
    const joined = await sql`
      insert into memberships (workspace_id, user_id, role, display_name)
      values (${invitation.workspaceId}, ${userId}, ${invitation.role}, ${displayNameFrom({ name, email })})
      on conflict (workspace_id, user_id) do update set role = excluded.role, removed_at = null
        where memberships.removed_at is not null
      returning user_id`
    await sql`update invitations set accepted_at = now() where workspace_id = ${invitation.workspaceId} and id = ${invitation.id}`
    if (joined.length > 0)
      await sql`
        insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, payload, created_at)
        values (${invitation.workspaceId}, ${crypto.randomUUID()}, 'member.joined', 'member', ${userId},
          ${JSON.stringify({ memberId: userId, role: invitation.role, invitationId: invitation.id })}::jsonb, now())`
  }
}

export const bindAccountByEmail = async (sql: Sql, { issuer, subject }: VerifiedIdentity, email: string) => {
  const [user] = await sql<{ id: string }[]>`
    insert into users (id, email) values (${crypto.randomUUID()}, ${email})
    on conflict (email) do update set email = excluded.email returning id`
  if (!user) throw new AccountBoundElsewhere(email)
  const [hasAccount] = await sql`select 1 from account_identities where user_id = ${user.id} limit 1`
  if (hasAccount) throw new AccountBoundElsewhere(email)
  const [bound] = await sql<{ userId: string }[]>`
    insert into account_identities (issuer, subject, user_id) values (${issuer}, ${subject}, ${user.id})
    on conflict (issuer, subject) do update set issuer = excluded.issuer
    returning user_id as "userId"`
  return bound?.userId
}

export const signInWithAccount = (database: Database, identity: VerifiedIdentity) => {
  const email = normalizedEmail(identity.email)
  return database.$client.begin(async (sql) => {
    const [bound] = await sql<{ userId: string }[]>`
      select user_id as "userId" from account_identities
      where issuer = ${identity.issuer} and subject = ${identity.subject}`
    const userId =
      bound?.userId ?? (identity.canBindByEmail ? await bindAccountByEmail(sql, identity, email) : undefined)
    if (!userId) return { email }
    await joinInvitedWorkspaces(sql, { userId, email, name: identity.name, workspaceId: null })
    return { userId, email }
  })
}

const bindMemberByEmail = async (
  sql: Sql,
  { workspaceId, issuer, currentSubjectPattern }: WorkspaceSignIn,
  email: string,
) => {
  const [candidate] = await sql<{ id: string; isMember: boolean; isBound: boolean }[]>`
    select users.id,
      exists(select 1 from memberships where memberships.workspace_id = ${workspaceId}
        and memberships.user_id = users.id and memberships.removed_at is null) as "isMember",
      exists(select 1 from identities where identities.workspace_id = ${workspaceId}
        and identities.issuer = ${issuer} and identities.user_id = users.id
        and (${currentSubjectPattern ?? null}::text is null or identities.subject ~ ${currentSubjectPattern ?? null})) as "isBound"
    from users where email = ${email}`
  const [invitation] = await sql`
    select 1 from invitations where workspace_id = ${workspaceId} and email = ${email} and revoked_at is null
      and accepted_at is null and expires_at > now()`
  if (candidate?.isBound) return undefined
  if (candidate && (candidate.isMember || invitation)) return candidate.id
  if (!invitation) return undefined
  const [created] = await sql<{ id: string }[]>`
    insert into users (id, email) values (${crypto.randomUUID()}, ${email}) returning id`
  return created?.id
}

export const signInThroughWorkspace = (database: Database, signIn: WorkspaceSignIn, identity: VerifiedIdentity) => {
  const email = normalizedEmail(identity.email)
  const { workspaceId, issuer } = signIn
  const { subject, legacySubject = subject } = identity
  return database.$client.begin(async (sql) => {
    const [bound] = await sql<{ userId: string }[]>`
      select user_id as "userId" from identities
      where workspace_id = ${workspaceId} and issuer = ${issuer} and subject in (${subject}, ${legacySubject})
      order by subject = ${subject} desc limit 1`
    const userId = bound?.userId ?? (identity.canBindByEmail ? await bindMemberByEmail(sql, signIn, email) : undefined)
    if (!userId) return { email }
    await joinInvitedWorkspaces(sql, { userId, email, name: identity.name, workspaceId })
    await sql`
      insert into identities (workspace_id, issuer, subject, user_id)
      select workspace_id, ${issuer}, ${subject}, user_id from memberships
      where workspace_id = ${workspaceId} and user_id = ${userId} and removed_at is null
      on conflict do nothing`
    return { userId, email }
  })
}

const enqueueSweepStatement = `
  insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
  select workspace_id, gen_random_uuid()::text, sweep.type, '{}'::jsonb, now() + $2::interval, 0, 'queued'
  from workspaces cross join unnest($3::text[]) as sweep(type) where workspace_id = coalesce($1::text, workspace_id)
    and deleted_at is null
    and not exists(select 1 from jobs where jobs.workspace_id = workspaces.workspace_id and jobs.type = sweep.type
      and (jobs.state = 'running' or jobs.state = 'failed' and jobs.finished_at > now() - interval '1 hour'))
  on conflict do nothing`

export const recurringJobTypes = ['sessions.sweep', 'runtime.sweep', 'agent.sweep', 'usage.sync', 'audit.sweep']

export const enqueueSweeps = (database: Database, workspaceId: string | null = null) =>
  database.$client.unsafe(enqueueSweepStatement, [workspaceId, '0 seconds', recurringJobTypes])

export const sessionJobs = {
  'sessions.sweep': async (tx: ServerTransaction, workspaceId: WorkspaceId) => {
    await tx.dbTransaction.query('delete from sessions where workspace_id = $1 and expires_at < now()', [workspaceId])
    await tx.dbTransaction.query(
      `delete from jobs where workspace_id = $1 and state = 'done' and coalesce(finished_at, run_at) < now() - interval '1 day'`,
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
