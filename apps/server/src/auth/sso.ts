import { createHash } from 'node:crypto'
import type { Database } from '@spyria/db/postgres'
import {
  adminRoleId,
  builtInChatRoles,
  builtInWorkspaceRoles,
  MissingWorkspacePermission,
  type WorkspacePermission,
} from '@spyria/kernel'
import {
  DomainClaimed,
  DomainFixed,
  displayNameFrom,
  domainOfEmail,
  InvalidSsoSettings,
  MailNotConfigured,
  MailNotSent,
  Name,
  normalizedDomain,
  normalizedEmail,
  SsoDiscoveryFailed,
  type SsoDomainState,
  type SsoPreset,
  type SsoSettings,
  type SsoSettingsInput,
  type SsoSettingsView,
  ssoSettingsFrom,
  tenantIdOf,
  WorkspaceCreationClosed,
} from '@spyria/workspace/server'
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
            and sso_domains.domain = ${domain ?? ''}
            and (sso_domains.verified_at is not null or (select count(*) from workspaces) = 1)))
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

const assertNotVerifiedElsewhere = async (sql: Sql, workspaceId: string, issuer: string, domain: string) => {
  await sql`lock table sso_domains in share row exclusive mode`
  const [claimed] = await sql`
    select 1 from sso_domains join workspace_sso using (workspace_id)
    where workspace_id <> ${workspaceId} and issuer <> ${issuer} and verified_at is not null and domain = ${domain}
    limit 1`
  if (claimed) throw new DomainClaimed(domain)
}

const settingsOf = (sql: Sql, workspaceId: string) =>
  sql<(SsoSettings & Omit<SsoDomainState, 'domain'>)[]>`
    select preset, issuer, client_id as "clientId", domain, verified_at is not null as "isVerified",
      case when verified_at is null and verification_expires_at > now() then verification_email end as "sentTo",
      case when verified_at is null and verification_expires_at > now()
        then (extract(epoch from verification_expires_at) * 1000)::float8 end as "expiresAt"
    from workspace_sso join sso_domains using (workspace_id)
    where workspace_id = ${workspaceId} order by domain limit 1`

const storeSsoSettings = async (
  sql: Sql,
  {
    workspaceId,
    actorId,
    settings,
    encryptedClientSecret,
  }: { workspaceId: string; actorId: string; settings: SsoSettings; encryptedClientSecret: string | null },
) => {
  await assertNotVerifiedElsewhere(sql, workspaceId, settings.issuer, settings.domain)
  const [previous] = await settingsOf(sql, workspaceId)
  if (!previous && !encryptedClientSecret) throw new InvalidSsoSettings('A client secret is required')
  await sql`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${workspaceId}, ${settings.preset}, ${settings.issuer}, ${settings.clientId}, ${encryptedClientSecret ?? ''},
      now())
    on conflict (workspace_id) do update set preset = excluded.preset, issuer = excluded.issuer,
      client_id = excluded.client_id, updated_at = excluded.updated_at,
      encrypted_client_secret = coalesce(${encryptedClientSecret}::text, workspace_sso.encrypted_client_secret)`
  await sql`insert into sso_domains (workspace_id, domain) values (${workspaceId}, ${settings.domain}) on conflict do nothing`
  if (!previous || (['preset', 'issuer', 'clientId'] as const).some((key) => previous[key] !== settings[key]))
    await recordWorkspaceEvent(sql, workspaceId, 'sso.configured', actorId, settings)
  if (previous && encryptedClientSecret) await recordWorkspaceEvent(sql, workspaceId, 'sso.secret_rotated', actorId, {})
}

const ssoSettingsViewOf = async (sql: Sql, member: Member): Promise<SsoSettingsView | null> => {
  await requireMemberPermission(sql, member, 'sso.manage')
  const [stored] = await settingsOf(sql, member.workspaceId)
  if (!stored) return null
  const { isVerified, sentTo, expiresAt, ...settings } = stored
  return {
    ...settings,
    tenantId: settings.preset === 'microsoft' ? tenantIdOf(settings.issuer) : '',
    hasSecret: true,
    domainState: { domain: settings.domain, isVerified, sentTo, expiresAt },
  }
}

export const readSsoSettings = (database: Database, member: Member) =>
  database.$client.begin((sql) => ssoSettingsViewOf(sql, member))

export const saveSsoSettings = async (
  database: Database,
  dependencies: SsoDependencies,
  member: Member,
  input: SsoSettingsInput,
) => {
  const current = await readSsoSettings(database, member)
  if (current && normalizedDomain(input.domain) !== current.domain) throw new DomainFixed(current.domain)
  const settings = await checkedSettings(input, dependencies)
  const clientSecret = String(input.clientSecret ?? '').trim()
  if (clientSecret !== '' && !dependencies.secretBox)
    throw new InvalidSsoSettings('SPYRIA_SECRETS_KEY is not set on this server')
  const encryptedClientSecret =
    clientSecret === '' ? null : ((await dependencies.secretBox?.seal(clientSecret)) ?? null)
  return database.$client.begin(async (sql) => {
    await storeSsoSettings(sql, {
      workspaceId: member.workspaceId,
      actorId: member.userId,
      settings,
      encryptedClientSecret,
    })
    return ssoSettingsViewOf(sql, member)
  })
}

export const hasNoWorkspace = async (sql: Sql | Database['$client']) =>
  (await sql`select 1 from workspaces limit 1`).length === 0

const assertWorkspaceCreationOpen = async (sql: Sql | Database['$client']) => {
  if (!(await hasNoWorkspace(sql))) throw new WorkspaceCreationClosed()
}

export type FirstWorkspace = {
  workspaceName: string
  domain: string
  provider: Omit<SsoProvider, 'workspaceId' | 'updatedAt'>
}

export const prepareFirstWorkspace = async (
  database: Database,
  dependencies: SsoDependencies,
  form: Record<string, unknown>,
): Promise<FirstWorkspace> => {
  await assertWorkspaceCreationOpen(database.$client)
  const field = (name: string) => (typeof form[name] === 'string' ? form[name] : '').trim().slice(0, 500)
  const workspaceName = Name(field('name'))
  if (field('clientSecret') === '') throw new InvalidSsoSettings('A client secret is required')
  if (!dependencies.secretBox) throw new InvalidSsoSettings('SPYRIA_SECRETS_KEY is not set on this server')
  const settings = await checkedSettings(
    {
      preset: field('preset') as SsoPreset,
      issuer: field('issuer'),
      tenantId: field('tenantId'),
      clientId: field('clientId'),
      domain: field('domain'),
    },
    dependencies,
  )
  const { domain, ...provider } = settings
  return {
    workspaceName,
    domain,
    provider: { ...provider, encryptedClientSecret: await dependencies.secretBox.seal(field('clientSecret')) },
  }
}

export const createFirstWorkspace = async (
  database: Database,
  { workspaceName, domain, provider }: FirstWorkspace,
  identity: { email: string; name?: unknown; subject: string },
) => {
  const email = normalizedEmail(identity.email)
  if (domainOfEmail(email) !== domain)
    throw new InvalidSsoSettings(`${email} is not an address at ${domain}: no workspace was created`)
  const workspaceId = crypto.randomUUID()
  return database.$client.begin(async (sql) => {
    await sql`lock table workspaces in share row exclusive mode`
    await assertWorkspaceCreationOpen(sql)
    const [user] = await sql<{ id: string }[]>`
      insert into users (id, email) values (${crypto.randomUUID()}, ${email})
      on conflict (email) do update set email = excluded.email returning id`
    const userId = user?.id ?? ''
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
      values (${workspaceId}, ${userId}, ${adminRoleId}, ${displayNameFrom({ ...identity, email })})`
    await recordWorkspaceEvent(sql, workspaceId, 'member.joined', userId, { memberId: userId, role: adminRoleId })
    await storeSsoSettings(sql, {
      workspaceId,
      actorId: userId,
      settings: { preset: provider.preset, issuer: provider.issuer, clientId: provider.clientId, domain },
      encryptedClientSecret: provider.encryptedClientSecret,
    })
    await sql`
      insert into identities (workspace_id, issuer, subject, user_id)
      values (${workspaceId}, ${provider.issuer}, ${identity.subject}, ${userId})`
    return { workspaceId, userId }
  })
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
  await assertNotVerifiedElsewhere(sql, workspaceId, claim.issuer, domain)
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
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { send, pending } = await database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'sso.manage')
    if (domainOfEmail(address) !== claimedDomain || !address.split('@')[0])
      throw new InvalidSsoSettings(`Enter an address at ${claimedDomain}`)
    if (!mailer) throw new MailNotConfigured()
    const [stored] = await sql<
      {
        workspaceName: string
        previousEmail: string | null
        previousHash: string | null
        previousExpiresAt: string | null
      }[]
    >`
      update sso_domains set verification_email = ${address}, verification_token_hash = ${hashOf(token)},
        verification_expires_at = now() + ${verificationLifetime}::interval
      from workspaces
      where sso_domains.workspace_id = ${member.workspaceId} and domain = ${claimedDomain} and verified_at is null
        and workspaces.workspace_id = sso_domains.workspace_id
      returning workspaces.name as "workspaceName", old.verification_email as "previousEmail",
        old.verification_token_hash as "previousHash", old.verification_expires_at::text as "previousExpiresAt"`
    if (!stored)
      throw new InvalidSsoSettings(`${claimedDomain} is not a domain of this workspace waiting for verification`)
    return { send: mailer.send, pending: stored }
  })
  const link = `${appOrigin}${domainVerificationLinkPath}?token=${token}`
  await send({
    to: address,
    subject: `Verify ${claimedDomain} for Spyria`,
    text: `Open this link to confirm that the Spyria workspace ${pending.workspaceName} signs in people of ${claimedDomain}:\n\n${link}\n\nThe link works once and expires in 24 hours.`,
  }).catch(async (error: Error) => {
    await database.$client`
      update sso_domains set verification_email = ${pending.previousEmail},
        verification_token_hash = ${pending.previousHash},
        verification_expires_at = ${pending.previousExpiresAt}::timestamptz
      where workspace_id = ${member.workspaceId} and domain = ${claimedDomain} and verification_token_hash = ${hashOf(token)}`
    throw new MailNotSent(error.message)
  })
  return database.$client.begin((sql) => ssoSettingsViewOf(sql, member))
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
