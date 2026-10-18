import type { Database } from '@hq/db/postgres'
import {
  DomainClaimed,
  displayNameFrom,
  domainOfEmail,
  InvalidSsoSettings,
  NotWorkspaceAdmin,
  normalizedEmail,
  SsoDiscoveryFailed,
  type SsoPreset,
  type SsoSettings,
  type SsoSettingsInput,
  type SsoSettingsView,
  ssoSettingsFrom,
  tenantIdOf,
} from '@hq/workspace/server'
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
export type SsoDependencies = { secretBox?: SecretBox; microsoftLoginOrigin?: string }
type Sql = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
type Member = { workspaceId: string; userId: string }

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
        and (${domain ?? null}::text is null or ${domain ?? ''} = any(domains))
      order by workspaces.created_at limit 1`
  )[0]

const assertAdmin = async (sql: Sql, { workspaceId, userId }: Member) => {
  const [admin] = await sql`
    select 1 from memberships where workspace_id = ${workspaceId} and user_id = ${userId} and role = 'admin'
      and removed_at is null`
  if (!admin) throw new NotWorkspaceAdmin()
}

const recordWorkspaceEvent = (sql: Sql, workspaceId: string, type: string, actorId: string | null, payload: object) =>
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
  await sql`lock table workspace_sso in share row exclusive mode`
  const [claimed] = await sql<{ domain: string }[]>`
    select domain from workspace_sso, unnest(domains) as domain
    where workspace_id <> ${workspaceId} and issuer <> ${settings.issuer} and domain = any(${settings.domains}::text[])
    limit 1`
  if (claimed) throw new DomainClaimed(claimed.domain)
  const [previous] = await sql<SsoSettings[]>`
    select preset, issuer, client_id as "clientId", domains from workspace_sso where workspace_id = ${workspaceId}`
  if (!previous && clientSecret.trim() === '') throw new InvalidSsoSettings('A client secret is required')
  if (clientSecret.trim() !== '' && !secretBox) throw new InvalidSsoSettings('HQ_SECRETS_KEY is not set on this server')
  const encryptedClientSecret =
    clientSecret.trim() === '' ? null : ((await secretBox?.seal(clientSecret.trim())) ?? null)
  await sql`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, domains, updated_at)
    values (${workspaceId}, ${settings.preset}, ${settings.issuer}, ${settings.clientId}, ${encryptedClientSecret ?? ''},
      ${settings.domains}::text[], now())
    on conflict (workspace_id) do update set preset = excluded.preset, issuer = excluded.issuer,
      client_id = excluded.client_id, domains = excluded.domains, updated_at = excluded.updated_at,
      encrypted_client_secret = coalesce(${encryptedClientSecret}::text, workspace_sso.encrypted_client_secret)`
  if (JSON.stringify(previous) !== JSON.stringify(settings))
    await recordWorkspaceEvent(sql, workspaceId, 'sso.configured', actorId, settings)
  if (previous && encryptedClientSecret) await recordWorkspaceEvent(sql, workspaceId, 'sso.secret_rotated', actorId, {})
}

const ssoSettingsViewOf = async (sql: Sql, member: Member): Promise<SsoSettingsView | null> => {
  await assertAdmin(sql, member)
  const [settings] = await sql<SsoSettings[]>`
    select preset, issuer, client_id as "clientId", domains from workspace_sso where workspace_id = ${member.workspaceId}`
  return settings
    ? { ...settings, tenantId: settings.preset === 'microsoft' ? tenantIdOf(settings.issuer) : '', hasSecret: true }
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
    await sql`
      insert into memberships (workspace_id, user_id, role, display_name)
      values (${workspaceId}, ${userId}, 'admin', ${displayNameFrom({ email })})`
    await recordWorkspaceEvent(sql, workspaceId, 'member.joined', null, { memberId: userId, role: 'admin' })
    await storeSsoSettings(sql, dependencies, {
      workspaceId,
      actorId: null,
      settings,
      clientSecret: input.clientSecret,
    })
  })
  return { workspaceId }
}
