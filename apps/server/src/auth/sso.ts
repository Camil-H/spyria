import { createHash } from 'node:crypto'
import type { Database } from '@hq/db/postgres'
import {
  adminRoleId,
  builtInChatRoles,
  builtInWorkspaceRoles,
  MissingWorkspacePermission,
  type WorkspacePermission,
} from '@hq/kernel'
import {
  DomainClaimed,
  displayNameFrom,
  domainOfEmail,
  InvalidSsoSettings,
  MailNotConfigured,
  MailNotSent,
  normalizedEmail,
  SsoDiscoveryFailed,
  type SsoDomainState,
  type SsoPreset,
  type SsoSettings,
  type SsoSettingsInput,
  type SsoSettingsView,
  ssoSettingsFrom,
  tenantIdOf,
} from '@hq/workspace/server'
import type { Mailer } from './mail.ts'
import { discoverIssuer } from './oidc.ts'
import type { SecretBox } from './secret-box.ts'

export type SsoProvider = {
  workspaceId: string
  preset: SsoPreset
  issuer: string
  clientId: string
  encryptedClientSecret: string
  updatedAt: Date
}
export type SsoDependencies = {
  secretBox?: SecretBox
  microsoftLoginOrigin?: string
  mailer?: Mailer
  appOrigin?: string
}
export type Sql = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
type Member = { workspaceId: string; userId: string }

export const domainVerificationLinkPath = '/auth/verify-domain'
const verificationLifetime = '24 hours'
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

export const ssoProviderOf = async (
  database: Database,
  { workspaceId, domain }: { workspaceId?: string; domain?: string },
) =>
  (
    await database.$client<SsoProvider[]>`
      select workspace_id as "workspaceId", preset, issuer, client_id as "clientId",
        encrypted_client_secret as "encryptedClientSecret", updated_at as "updatedAt"
      from workspace_sso join workspaces using (workspace_id)
      where workspace_id = coalesce(${workspaceId ?? null}::text, workspace_id)
        and (${domain ?? null}::text is null or exists(
          select 1 from sso_domains where sso_domains.workspace_id = workspace_sso.workspace_id
            and sso_domains.domain = ${domain ?? ''} and sso_domains.verified_at is not null))
      order by workspaces.created_at limit 1`
  )[0]

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

export const recordWorkspaceEvent = (
  sql: Sql,
  workspaceId: string,
  type: string,
  actorId: string | null,
  payload: object,
) =>
  sql`
    insert into workspace_events (workspace_id, id, type, actor_id, payload, created_at)
    values (${workspaceId}, ${crypto.randomUUID()}, ${type}, ${actorId}, ${JSON.stringify(payload)}::jsonb, now())`

const checkedSettings = async (input: SsoSettingsInput, { microsoftLoginOrigin }: SsoDependencies) => {
  const settings = ssoSettingsFrom(input, microsoftLoginOrigin)
  await discoverIssuer(settings.issuer).catch((error: Error) => {
    throw new SsoDiscoveryFailed(settings.issuer, error.message)
  })
  return settings
}

const assertNotVerifiedElsewhere = async (sql: Sql, workspaceId: string, issuer: string, domains: string[]) => {
  await sql`lock table sso_domains in share row exclusive mode`
  const [claimed] = await sql<{ domain: string }[]>`
    select domain from sso_domains join workspace_sso using (workspace_id)
    where workspace_id <> ${workspaceId} and issuer <> ${issuer} and verified_at is not null
      and domain = any(${domains}::text[])
    limit 1`
  if (claimed) throw new DomainClaimed(claimed.domain)
}

const settingsOf = (sql: Sql, workspaceId: string) =>
  sql<SsoSettings[]>`
    select preset, issuer, client_id as "clientId",
      array(select domain from sso_domains where sso_domains.workspace_id = workspace_sso.workspace_id order by domain)
        as domains
    from workspace_sso where workspace_id = ${workspaceId}`

const storeSsoSettings = async (
  sql: Sql,
  { secretBox }: SsoDependencies,
  {
    workspaceId,
    actorId,
    settings,
    clientSecret = '',
  }: {
    workspaceId: string
    actorId: string | null
    settings: SsoSettings
    clientSecret?: string
  },
) => {
  await assertNotVerifiedElsewhere(sql, workspaceId, settings.issuer, settings.domains)
  const [previous] = await settingsOf(sql, workspaceId)
  if (!previous && clientSecret.trim() === '') throw new InvalidSsoSettings('A client secret is required')
  if (clientSecret.trim() !== '' && !secretBox) throw new InvalidSsoSettings('HQ_SECRETS_KEY is not set on this server')
  const encryptedClientSecret =
    clientSecret.trim() === '' ? null : ((await secretBox?.seal(clientSecret.trim())) ?? null)
  await sql`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${workspaceId}, ${settings.preset}, ${settings.issuer}, ${settings.clientId}, ${encryptedClientSecret ?? ''},
      now())
    on conflict (workspace_id) do update set preset = excluded.preset, issuer = excluded.issuer,
      client_id = excluded.client_id, updated_at = excluded.updated_at,
      encrypted_client_secret = coalesce(${encryptedClientSecret}::text, workspace_sso.encrypted_client_secret)`
  await sql`
    delete from sso_domains where workspace_id = ${workspaceId} and domain <> all(${settings.domains}::text[])`
  await sql`
    insert into sso_domains (workspace_id, domain, verified_at)
    select ${workspaceId}, domain, case when ${actorId}::text is null then now() end
    from unnest(${settings.domains}::text[]) as domain
    on conflict do nothing`
  const domains = settings.domains.toSorted()
  if (JSON.stringify(previous) !== JSON.stringify({ ...settings, domains }))
    await recordWorkspaceEvent(sql, workspaceId, 'sso.configured', actorId, settings)
  if (previous && encryptedClientSecret) await recordWorkspaceEvent(sql, workspaceId, 'sso.secret_rotated', actorId, {})
}

const ssoSettingsViewOf = async (sql: Sql, member: Member): Promise<SsoSettingsView | null> => {
  await requireMemberPermission(sql, member, 'sso.manage')
  const [settings] = await settingsOf(sql, member.workspaceId)
  const domainStates = await sql<SsoDomainState[]>`
    select domain, verified_at is not null as "isVerified",
      case when verified_at is null and verification_expires_at > now() then verification_email end as "sentTo",
      case when verified_at is null and verification_expires_at > now()
        then (extract(epoch from verification_expires_at) * 1000)::float8 end as "expiresAt"
    from sso_domains where workspace_id = ${member.workspaceId} order by domain`
  return settings
    ? {
        ...settings,
        tenantId: settings.preset === 'microsoft' ? tenantIdOf(settings.issuer) : '',
        hasSecret: true,
        domainStates: [...domainStates],
      }
    : null
}

export const readSsoSettings = (database: Database, member: Member) =>
  database.$client.begin((sql) => ssoSettingsViewOf(sql, member))

export const saveSsoSettings = async (
  database: Database,
  dependencies: SsoDependencies,
  member: Member,
  input: SsoSettingsInput,
) => {
  await readSsoSettings(database, member)
  const settings = await checkedSettings(input, dependencies)
  return database.$client.begin(async (sql) => {
    await storeSsoSettings(sql, dependencies, {
      workspaceId: member.workspaceId,
      actorId: member.userId,
      settings,
      clientSecret: input.clientSecret,
    })
    return ssoSettingsViewOf(sql, member)
  })
}

export const bootstrapSsoWorkspace = async (
  database: Database,
  dependencies: SsoDependencies,
  { workspaceName, adminEmail, ...input }: SsoSettingsInput & { workspaceName: string; adminEmail: string },
) => {
  const email = normalizedEmail(adminEmail)
  const settings = await checkedSettings(input, dependencies)
  if (!settings.domains.includes(domainOfEmail(email)))
    throw new InvalidSsoSettings(`${email} is not in the email domains of the workspace`)
  if (workspaceName.trim() === '') throw new InvalidSsoSettings('A workspace name is required')
  const workspaceId = crypto.randomUUID()
  await database.$client.begin(async (sql) => {
    const [user] = await sql<{ id: string }[]>`
      insert into users (id, email) values (${crypto.randomUUID()}, ${email})
      on conflict (email) do update set email = excluded.email returning id`
    const userId = user?.id ?? ''
    await sql`
      insert into workspaces (workspace_id, name, created_by, created_at)
      values (${workspaceId}, ${workspaceName.trim()}, ${userId}, now())`
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
      values (${workspaceId}, ${userId}, ${adminRoleId}, ${displayNameFrom({ email })})`
    await recordWorkspaceEvent(sql, workspaceId, 'member.joined', null, { memberId: userId, role: adminRoleId })
    await storeSsoSettings(sql, dependencies, {
      workspaceId,
      actorId: null,
      settings,
      clientSecret: input.clientSecret,
    })
  })
  return { workspaceId }
}

const markDomainVerified = async (
  sql: Sql,
  {
    workspaceId,
    domain,
    actorId,
    email,
  }: { workspaceId: string; domain: string; actorId: string | null; email?: string },
) => {
  const [claim] = await sql<{ issuer: string }[]>`
    select issuer from sso_domains join workspace_sso using (workspace_id)
    where workspace_id = ${workspaceId} and domain = ${domain}`
  if (!claim) throw new InvalidSsoSettings(`${domain} is not a domain of this workspace`)
  await assertNotVerifiedElsewhere(sql, workspaceId, claim.issuer, [domain])
  await sql`
    update sso_domains set verified_at = now(), verification_token_hash = null, verification_expires_at = null
    where workspace_id = ${workspaceId} and domain = ${domain}`
  await recordWorkspaceEvent(sql, workspaceId, 'sso.domain_verified', actorId, { domain, ...(email && { email }) })
}

export const sendDomainVerification = async (
  database: Database,
  { mailer, appOrigin }: SsoDependencies,
  member: Member,
  { domain, email }: { domain?: unknown; email?: unknown },
) => {
  const address = normalizedEmail(String(email ?? ''))
  const claimedDomain = String(domain ?? '')
  return database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'sso.manage')
    if (domainOfEmail(address) !== claimedDomain || !address.split('@')[0])
      throw new InvalidSsoSettings(`Enter an address at ${claimedDomain}`)
    if (!mailer) throw new MailNotConfigured()
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const [pending] = await sql<{ workspaceName: string }[]>`
      update sso_domains set verification_email = ${address}, verification_token_hash = ${hashOf(token)},
        verification_expires_at = now() + ${verificationLifetime}::interval
      from workspaces
      where sso_domains.workspace_id = ${member.workspaceId} and domain = ${claimedDomain} and verified_at is null
        and workspaces.workspace_id = sso_domains.workspace_id
      returning workspaces.name as "workspaceName"`
    if (!pending)
      throw new InvalidSsoSettings(`${claimedDomain} is not a domain of this workspace waiting for verification`)
    const link = `${appOrigin}${domainVerificationLinkPath}?token=${token}`
    await mailer
      .send({
        to: address,
        subject: `Verify ${claimedDomain} for HQ`,
        text: `Open this link to confirm that the HQ workspace ${pending.workspaceName} signs in people of ${claimedDomain}:\n\n${link}\n\nThe link works once and expires in 24 hours.`,
      })
      .catch((error: Error) => {
        throw new MailNotSent(error.message)
      })
    return ssoSettingsViewOf(sql, member)
  })
}

export const verifyDomainByToken = (database: Database, token: string) =>
  database.$client.begin(async (sql) => {
    const [pending] = await sql<{ workspaceId: string; domain: string; email: string }[]>`
      select workspace_id as "workspaceId", domain, verification_email as email from sso_domains
      where verification_token_hash = ${hashOf(token)} and verification_expires_at > now() and verified_at is null
      for update`
    if (!pending) return undefined
    await markDomainVerified(sql, { ...pending, actorId: null })
    return pending.domain
  })

export const verifyDomainByOperator = (database: Database, workspaceId: string, domain: string) =>
  database.$client.begin((sql) => markDomainVerified(sql, { workspaceId, domain, actorId: null }))
