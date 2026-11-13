import { type Database, transactWithin } from '@spyria/db/postgres'
import {
  type Actor,
  adminRoleId,
  builtInChatRoles,
  builtInWorkspaceRoles,
  log,
  MissingWorkspacePermission,
  memberActor,
  memberId,
  workspaceId as spyriaWorkspaceId,
  storedActorOf,
  systemActor,
  type WorkspacePermission,
} from '@spyria/kernel'
import { addInstallHostIn } from '@spyria/runtime/server'
import {
  type AccountProvider,
  ClaimedDomainCannotCreate,
  displayNameFrom,
  domainOfEmail,
  EmailNotConfirmed,
  type InstanceApps,
  InstanceBeingSetUp,
  InvalidSsoSettings,
  instanceAppFor,
  Name,
  NoAccountSignIn,
  normalizedEmail,
  SsoAddressMismatch,
  SsoDiscoveryFailed,
  type SsoPreset,
  type SsoSettings,
  type SsoSettingsInput,
  type SsoSettingsView,
  ssoSettingsFrom,
  tenantIdOf,
  WorkspaceCreationClosed,
} from '@spyria/workspace/server'
import { discoverIssuer } from './oidc.ts'
import type { SecretBox } from './secret-box.ts'
import { bindAccountByEmail, claimedDomainsOf, type Sql, type VerifiedIdentity } from './sessions.ts'

export type SsoProvider = {
  workspaceId: string
  preset: SsoPreset
  issuer: string
  clientId: string
  encryptedClientSecret: string
  usesInstanceApp: boolean
}
export type SsoDependencies = {
  secretBox?: SecretBox
  microsoftLoginOrigin?: string
  instanceApps?: InstanceApps
  installHostToken?: string
  requiresHttpsIssuers?: boolean
}
type Member = { workspaceId: string; userId: string }
type OwnProvider = Omit<SsoProvider, 'workspaceId'>

export const workspaceProviderOf = async (database: Database, workspaceId: string) =>
  (
    await database.$client<SsoProvider[]>`
      select workspace_id as "workspaceId", preset, issuer, client_id as "clientId",
        encrypted_client_secret as "encryptedClientSecret", uses_instance_app as "usesInstanceApp"
      from workspace_sso join workspaces using (workspace_id)
      where workspace_id = ${workspaceId} and workspaces.deleted_at is null`
  )[0]

export const workspaceProvidersForEmail = (database: Database, email: string) =>
  database.$client<{ workspaceId: string; preset: SsoPreset; isClaiming: boolean }[]>`
    select workspace_id as "workspaceId", preset, claimed.is_claiming as "isClaiming"
    from workspace_sso join workspaces using (workspace_id)
      cross join lateral (select exists(select 1 from domain_claims
        where domain_claims.workspace_id = workspace_sso.workspace_id and domain_claims.domain = ${domainOfEmail(email)}
          and domain_claims.verified_at is not null) as is_claiming) as claimed
    where workspaces.deleted_at is null and (
      claimed.is_claiming
      or exists(select 1 from invitations where invitations.workspace_id = workspace_sso.workspace_id
        and invitations.email = ${normalizedEmail(email)} and revoked_at is null and accepted_at is null
        and expires_at > now())
      or exists(select 1 from memberships join users on users.id = memberships.user_id
        where memberships.workspace_id = workspace_sso.workspace_id and memberships.removed_at is null
          and users.email = ${normalizedEmail(email)}))
    order by claimed.is_claiming desc, workspaces.created_at, workspace_id`

export const requireMemberPermission = async (
  sql: Sql,
  { workspaceId, userId }: Member,
  permission: WorkspacePermission,
) => {
  const [granted] = await sql`
    select 1 from memberships member
    join workspace_role_permissions granted on granted.workspace_id = member.workspace_id
      and granted.role_id = member.role
    where member.workspace_id = ${workspaceId} and member.user_id = ${userId} and member.removed_at is null
      and granted.permission = ${permission}`
  if (!granted) throw new MissingWorkspacePermission(permission)
}

export const recordWorkspaceEvent = (sql: Sql, workspaceId: string, type: string, actor: Actor, payload: object) => {
  const { kind, id, onBehalfOf } = storedActorOf(actor)
  return sql`
    insert into workspace_events (workspace_id, id, type, actor_kind, actor_id, on_behalf_of, payload, created_at)
    values (${workspaceId}, ${crypto.randomUUID()}, ${type}, ${kind}, ${id}, ${onBehalfOf},
      ${JSON.stringify(payload)}::jsonb, now())`
}

const formField = (form: Record<string, unknown>, name: string) =>
  (typeof form[name] === 'string' ? form[name] : '').trim().slice(0, 500)

type StoredApp = { issuer: string; clientId: string; encryptedClientSecret: string }

const ownProviderFrom = async (
  form: Record<string, unknown>,
  { microsoftLoginOrigin, instanceApps, secretBox, requiresHttpsIssuers }: SsoDependencies,
  stored?: StoredApp,
): Promise<OwnProvider> => {
  const input: SsoSettingsInput = {
    preset: formField(form, 'preset') as SsoPreset,
    issuer: formField(form, 'issuer'),
    tenantId: formField(form, 'tenantId'),
    clientId: formField(form, 'clientId'),
    usesInstanceApp: formField(form, 'usesInstanceApp') === 'true',
  }
  const clientSecret = input.usesInstanceApp ? '' : formField(form, 'clientSecret')
  if (clientSecret !== '' && !secretBox) throw new InvalidSsoSettings('SPYRIA_SECRETS_KEY is not set on this server')
  const clientId = input.usesInstanceApp ? instanceAppFor(instanceApps ?? {}, input.preset).clientId : input.clientId
  const settings = ssoSettingsFrom({ ...input, clientId }, microsoftLoginOrigin)
  const keptSecret =
    stored?.issuer === settings.issuer && stored.clientId === settings.clientId ? stored.encryptedClientSecret : ''
  if (!input.usesInstanceApp && clientSecret === '' && keptSecret === '')
    throw new InvalidSsoSettings('A client secret is required')
  if (requiresHttpsIssuers && new URL(settings.issuer).protocol !== 'https:')
    throw new InvalidSsoSettings('The issuer must be an https URL')
  await discoverIssuer(settings.issuer).catch((error: Error) => {
    log.warn({
      event: 'sso.discovery_failed',
      body: `The discovery of ${settings.issuer} failed`,
      attributes: { 'spyria.sso.issuer': settings.issuer },
      error,
    })
    throw new SsoDiscoveryFailed(settings.issuer)
  })
  const encryptedClientSecret = clientSecret === '' ? keptSecret : ((await secretBox?.seal(clientSecret)) ?? '')
  return {
    ...settings,
    usesInstanceApp: input.usesInstanceApp === true,
    encryptedClientSecret: input.usesInstanceApp ? '' : encryptedClientSecret,
  }
}

const settingsOf = (sql: Sql, workspaceId: string) =>
  sql<(SsoSettings & { usesInstanceApp: boolean; encryptedClientSecret: string })[]>`
    select preset, issuer, client_id as "clientId", uses_instance_app as "usesInstanceApp",
      encrypted_client_secret as "encryptedClientSecret"
    from workspace_sso where workspace_id = ${workspaceId}`

const storeSsoSettings = async (sql: Sql, workspaceId: string, actor: Actor, provider: OwnProvider) => {
  const [previous] = await settingsOf(sql, workspaceId)
  const encryptedClientSecret = provider.usesInstanceApp
    ? ''
    : provider.encryptedClientSecret || previous?.encryptedClientSecret || ''
  if (!provider.usesInstanceApp && encryptedClientSecret === '')
    throw new InvalidSsoSettings('A client secret is required')
  await sql`
    insert into workspace_sso
      (workspace_id, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, updated_at)
    values (${workspaceId}, ${provider.preset}, ${provider.issuer}, ${provider.clientId}, ${encryptedClientSecret},
      ${provider.usesInstanceApp}, now())
    on conflict (workspace_id) do update set preset = excluded.preset, issuer = excluded.issuer,
      client_id = excluded.client_id, uses_instance_app = excluded.uses_instance_app, updated_at = excluded.updated_at,
      encrypted_client_secret = excluded.encrypted_client_secret`
  if (previous?.issuer !== provider.issuer) await sql`delete from sessions where workspace_id = ${workspaceId}`
  const { preset, issuer, clientId, usesInstanceApp } = provider
  const isChanged =
    !previous ||
    previous.usesInstanceApp !== usesInstanceApp ||
    previous.preset !== preset ||
    previous.issuer !== issuer ||
    previous.clientId !== clientId
  if (isChanged)
    await recordWorkspaceEvent(sql, workspaceId, 'sso.configured', actor, {
      preset,
      issuer,
      clientId,
      ...(usesInstanceApp && { usesInstanceApp }),
    })
  if (previous && provider.encryptedClientSecret && provider.encryptedClientSecret !== previous.encryptedClientSecret)
    await recordWorkspaceEvent(sql, workspaceId, 'sso.secret_rotated', actor, {})
}

const ssoSettingsViewOf = async (sql: Sql, member: Member): Promise<SsoSettingsView | null> => {
  await requireMemberPermission(sql, member, 'sso.manage')
  const [stored] = await settingsOf(sql, member.workspaceId)
  if (!stored) return null
  const { encryptedClientSecret: _, ...settings } = stored
  return {
    ...settings,
    tenantId: settings.preset === 'microsoft' ? tenantIdOf(settings.issuer) : '',
    hasSecret: !settings.usesInstanceApp,
  }
}

export const readSsoSettings = (database: Database, member: Member) =>
  database.$client.begin((sql) => ssoSettingsViewOf(sql, member))

export type PendingSso = { workspaceId: string; userId: string; email: string; provider: OwnProvider }

export const prepareSsoSettings = async (
  database: Database,
  dependencies: SsoDependencies,
  member: Member,
  form: Record<string, unknown>,
): Promise<PendingSso> => {
  const { email, stored } = await database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'sso.manage')
    const [user] = await sql<{ email: string }[]>`select email from users where id = ${member.userId}`
    return { email: user?.email ?? '', stored: (await settingsOf(sql, member.workspaceId))[0] }
  })
  return { ...member, email, provider: await ownProviderFrom(form, dependencies, stored) }
}

export const confirmSsoSettings = (database: Database, pending: PendingSso, identity: VerifiedIdentity) =>
  database.$client.begin(async (sql) => {
    const { workspaceId, userId, provider } = pending
    await requireMemberPermission(sql, pending, 'sso.manage')
    if (normalizedEmail(identity.email) !== pending.email) throw new SsoAddressMismatch(pending.email)
    const [boundToSomeoneElse] = await sql`
      select 1 from identities
      where workspace_id = ${workspaceId} and issuer = ${provider.issuer} and subject = ${identity.subject}
        and user_id <> ${userId}`
    if (boundToSomeoneElse) throw new SsoAddressMismatch(pending.email)
    await storeSsoSettings(sql, workspaceId, memberActor(memberId(userId)), provider)
    await sql`
      insert into identities (workspace_id, issuer, subject, user_id)
      values (${workspaceId}, ${provider.issuer}, ${identity.subject}, ${userId})
      on conflict do nothing`
    return { workspaceId, userId }
  })

const removeWorkspaceSso = async (sql: Sql, workspaceId: string, actor: Actor) => {
  const removed = await sql`delete from workspace_sso where workspace_id = ${workspaceId} returning 1`
  if (removed.length === 0) return false
  await sql`delete from sessions where workspace_id = ${workspaceId}`
  await recordWorkspaceEvent(sql, workspaceId, 'sso.removed', actor, {})
  return true
}

export const stopWorkspaceSso = (database: Database, member: Member, hasAccountSignIn: boolean) =>
  database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'sso.manage')
    if (!hasAccountSignIn) throw new NoAccountSignIn()
    await removeWorkspaceSso(sql, member.workspaceId, memberActor(memberId(member.userId)))
  })

export const stopWorkspaceSsoByOperator = (database: Database, workspaceId: string) =>
  database.$client.begin((sql) => removeWorkspaceSso(sql, workspaceId, systemActor('operator')))

export const hasNoWorkspace = async (sql: Sql | Database['$client']) =>
  (await sql`select 1 from workspaces limit 1`).length === 0

const insertWorkspace = async (
  sql: Sql,
  {
    userId,
    workspaceName,
    identity,
  }: { userId: string; workspaceName: Name; identity: { email: string; name?: unknown } },
) => {
  const workspaceId = crypto.randomUUID()
  await sql`
    insert into workspaces (workspace_id, name, created_by, created_at)
    values (${workspaceId}, ${workspaceName}, ${userId}, now())`
  for (const role of builtInWorkspaceRoles) {
    await sql`
      insert into workspace_roles (workspace_id, id, name, built_in) values (${workspaceId}, ${role.id}, ${role.name}, true)`
    for (const permission of role.permissions)
      await sql`
        insert into workspace_role_permissions (workspace_id, role_id, permission)
        values (${workspaceId}, ${role.id}, ${permission})`
  }
  for (const role of builtInChatRoles)
    await sql`
      insert into chat_roles (workspace_id, id, name, permissions, built_in)
      values (${workspaceId}, ${role.id}, ${role.name}, ${sql.array([...role.permissions])}, true)`
  await sql`
    insert into memberships (workspace_id, user_id, role, display_name)
    values (${workspaceId}, ${userId}, ${adminRoleId}, ${displayNameFrom(identity)})`
  await recordWorkspaceEvent(sql, workspaceId, 'member.joined', memberActor(memberId(userId)), {
    memberId: userId,
    role: adminRoleId,
  })
  return workspaceId
}

export const createWorkspaceOfAccount = async (database: Database, userId: string, name: unknown) => {
  const workspaceName = Name(String(name ?? '').trim())
  return database.$client.begin(async (sql) => {
    const [user] = await sql<{ email: string }[]>`select email from users where id = ${userId}`
    if (!user || (await hasNoWorkspace(sql))) throw new InstanceBeingSetUp()
    if ((await claimedDomainsOf(sql, domainOfEmail(user.email))).length > 0) throw new ClaimedDomainCannotCreate()
    return insertWorkspace(sql, { userId, workspaceName, identity: user })
  })
}

export type FirstWorkspace = { workspaceName: Name } & (
  | { accountProvider: AccountProvider; provider?: undefined }
  | { accountProvider?: undefined; provider: OwnProvider }
)

const assertWorkspaceCreationOpen = async (sql: Sql | Database['$client']) => {
  if (!(await hasNoWorkspace(sql))) throw new WorkspaceCreationClosed()
}

export const prepareFirstWorkspace = async (
  database: Database,
  dependencies: SsoDependencies,
  form: Record<string, unknown>,
  accountProviders: readonly AccountProvider[],
): Promise<FirstWorkspace> => {
  await assertWorkspaceCreationOpen(database.$client)
  const workspaceName = Name(formField(form, 'name'))
  const accountProvider = accountProviders.find((provider) => provider === formField(form, 'accountProvider'))
  if (accountProvider) return { workspaceName, accountProvider }
  return { workspaceName, provider: await ownProviderFrom(form, dependencies) }
}

const upsertUserByEmail = async (sql: Sql, email: string) => {
  const [user] = await sql<{ id: string }[]>`
    insert into users (id, email) values (${crypto.randomUUID()}, ${email})
    on conflict (email) do update set email = excluded.email returning id`
  return user?.id ?? ''
}

const accountUserOf = async (sql: Sql, identity: VerifiedIdentity, email: string) => {
  const [bound] = await sql<{ id: string }[]>`
    select user_id as id from account_identities where issuer = ${identity.issuer} and subject = ${identity.subject}`
  if (bound) return bound.id
  if (!identity.canBindByEmail) throw new EmailNotConfirmed()
  return (await bindAccountByEmail(sql, identity, email)) ?? ''
}

export const createFirstWorkspace = async (
  database: Database,
  { workspaceName, provider }: FirstWorkspace,
  identity: VerifiedIdentity,
  { installHostToken }: Pick<SsoDependencies, 'installHostToken'> = {},
) => {
  const email = normalizedEmail(identity.email)
  return database.$client.begin(async (sql) => {
    await sql`lock table workspaces in share row exclusive mode`
    await assertWorkspaceCreationOpen(sql)
    const userId = provider ? await upsertUserByEmail(sql, email) : await accountUserOf(sql, identity, email)
    const workspaceId = await insertWorkspace(sql, { userId, workspaceName, identity: { ...identity, email } })
    if (provider) {
      await storeSsoSettings(sql, workspaceId, memberActor(memberId(userId)), provider)
      await sql`
        insert into identities (workspace_id, issuer, subject, user_id)
        values (${workspaceId}, ${provider.issuer}, ${identity.subject}, ${userId})`
    }
    if (installHostToken)
      await transactWithin(sql)((tx) =>
        addInstallHostIn(tx, {
          workspaceId: spyriaWorkspaceId(workspaceId),
          memberId: memberId(userId),
          installHostToken,
        }),
      )
    return { workspaceId, userId }
  })
}

export const assertInstanceAppsConfigured = async (database: Database, instanceApps: InstanceApps) => {
  const missing = (
    await database.$client<{ preset: SsoPreset; count: number }[]>`
      select preset, count(*)::int as count from workspace_sso join workspaces using (workspace_id)
      where uses_instance_app and workspaces.deleted_at is null group by preset order by preset`
  ).filter(({ preset }) => preset === 'oidc' || !instanceApps[preset])
  if (missing.length > 0)
    throw new Error(
      `Workspaces sign in through apps of this deployment that are not configured: ${missing
        .map(({ preset, count }) => `${preset} (${count} workspace${count === 1 ? '' : 's'})`)
        .join(', ')}. Set SPYRIA_GOOGLE_CLIENT_* or SPYRIA_MICROSOFT_CLIENT_* again.`,
    )
}
