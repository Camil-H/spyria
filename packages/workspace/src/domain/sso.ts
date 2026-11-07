import { InvalidSsoSettings, PublicEmailDomain } from './errors.ts'

export const ssoPresets = ['google', 'microsoft', 'oidc'] as const
export type SsoPreset = (typeof ssoPresets)[number]
export type JoinBy = 'domain' | 'invited_address'
export type SsoSettingsInput = {
  preset: SsoPreset
  issuer?: string
  tenantId?: string
  clientId: string
  clientSecret?: string
  usesInstanceApp?: boolean
  domain?: string
}
export type SsoSettings = { preset: SsoPreset; issuer: string; clientId: string; domain: string | null }
export type SsoDomainState = { domain: string; isVerified: boolean; sentTo: string | null; expiresAt: number | null }
export type SsoSettingsView = SsoSettings & {
  joinBy: JoinBy
  tenantId: string
  hasSecret: boolean
  usesInstanceApp: boolean
  domainState: SsoDomainState | null
}
export type SsoEmail =
  | { email: string; refusal?: undefined }
  | { email?: undefined; refusal: 'unconfirmed' | 'untrusted' }
export const instanceAppPresets = ['google', 'microsoft'] as const
export type InstanceAppPreset = (typeof instanceAppPresets)[number]
export type InstanceApps = Partial<Record<InstanceAppPreset, { clientId: string; clientSecret: string }>>

export const googleIssuer = 'https://accounts.google.com'
export const microsoftLoginOrigin = 'https://login.microsoftonline.com'
const multiTenantSegments = new Set(['common', 'organizations', 'consumers'])
const tenantIdPattern = /^[\w.-]+$/
const domainPattern = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const publicEmailDomains = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
])
const joinBySettings: Record<string, JoinBy> = { domain: 'domain', 'invited-address': 'invited_address' }

export const joinByOf = (setting: string | undefined): JoinBy => {
  const joinBy = joinBySettings[setting || 'domain']
  if (!joinBy) throw new Error('SPYRIA_JOIN_BY must be domain or invited-address')
  return joinBy
}

export const isPublicEmailDomain = (domain: string) => publicEmailDomains.has(domain)

export const domainOfEmail = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

export const normalizedDomain = (domain: unknown) =>
  String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')

export const tenantIdOf = (issuer: string) => new URL(issuer).pathname.split('/')[1] ?? ''

const issuerOf = ({ preset, issuer = '', tenantId = '' }: SsoSettingsInput, microsoftOrigin: string) => {
  if (typeof issuer !== 'string' || typeof tenantId !== 'string')
    throw new InvalidSsoSettings('The issuer must be a URL')
  if (preset === 'google') return googleIssuer
  if (preset === 'microsoft') {
    if (!tenantIdPattern.test(tenantId.trim())) throw new InvalidSsoSettings('A Microsoft Entra tenant id is required')
    return `${microsoftOrigin}/${tenantId.trim()}/v2.0`
  }
  const url = URL.parse(issuer.trim())
  if (!url || !['https:', 'http:'].includes(url.protocol)) throw new InvalidSsoSettings('The issuer must be a URL')
  return url.href.replace(/\/$/, '')
}

const ownedDomainOf = (input: SsoSettingsInput, joinBy: JoinBy) => {
  const domain = normalizedDomain(input.domain)
  if (joinBy === 'invited_address') {
    if (domain !== '') throw new InvalidSsoSettings('A workspace joined by invited address owns no email domain')
    return null
  }
  if (domain === '') throw new InvalidSsoSettings('An email domain is required')
  if (!domainPattern.test(domain)) throw new InvalidSsoSettings(`${domain} is not an email domain`)
  if (isPublicEmailDomain(domain)) throw new PublicEmailDomain(domain)
  return domain
}

export const ssoSettingsFrom = (
  input: SsoSettingsInput,
  joinBy: JoinBy = 'domain',
  microsoftOrigin = microsoftLoginOrigin,
): SsoSettings => {
  if (!ssoPresets.includes(input.preset)) throw new InvalidSsoSettings(`${input.preset} is not a provider preset`)
  const issuer = issuerOf(input, microsoftOrigin)
  const isEntra = input.preset === 'microsoft' || issuer.startsWith(microsoftLoginOrigin)
  if (isEntra && multiTenantSegments.has(tenantIdOf(issuer).toLowerCase()))
    throw new InvalidSsoSettings('Only a tenant-specific Microsoft Entra issuer is accepted')
  const clientId = String(input.clientId ?? '').trim()
  if (clientId === '') throw new InvalidSsoSettings('A client id is required')
  return { preset: input.preset, issuer, clientId, domain: ownedDomainOf(input, joinBy) }
}

const addressOf = (value: unknown) => (typeof value === 'string' && value.includes('@') ? value : undefined)

const confirmedEmailOf = (claims: Record<string, unknown>): SsoEmail => {
  const email = addressOf(claims.email)
  if (email === undefined) return { refusal: 'untrusted' }
  return claims.email_verified === true ? { email } : { refusal: 'unconfirmed' }
}

const googleEmailOf = (claims: Record<string, unknown>, joinBy: JoinBy): SsoEmail => {
  const confirmed = confirmedEmailOf(claims)
  if (confirmed.refusal || joinBy === 'invited_address') return confirmed
  return claims.hd === domainOfEmail(confirmed.email) ? confirmed : { refusal: 'untrusted' }
}

export const ssoEmailOf = (preset: SsoPreset, claims: Record<string, unknown>, joinBy: JoinBy): SsoEmail => {
  if (preset === 'google') return googleEmailOf(claims, joinBy)
  if (preset === 'oidc') return confirmedEmailOf(claims)
  const email = addressOf(claims.preferred_username ?? claims.email)
  return email === undefined ? { refusal: 'untrusted' } : { email }
}

export const entraObjectIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const ssoCanBindByEmail = (preset: SsoPreset, claims: Record<string, unknown>) =>
  preset !== 'microsoft' || typeof claims.idp !== 'string' || claims.idp === claims.iss

const instanceAppNames: Record<InstanceAppPreset, string> = { google: 'Google', microsoft: 'Microsoft' }

export const instanceAppFor = (instanceApps: InstanceApps, preset: SsoPreset) => {
  if (preset === 'oidc')
    throw new InvalidSsoSettings('Only Google Workspace and Microsoft Entra sign in through the app of this Spyria')
  const app = instanceApps[preset]
  if (!app)
    throw new InvalidSsoSettings(
      `This Spyria has no ${instanceAppNames[preset]} app: enter the client id and secret of your own`,
    )
  return app
}

export const ssoSubjectOf = (preset: SsoPreset, claims: Record<string, unknown>) => {
  const subject = preset === 'microsoft' ? claims.oid : claims.sub
  return typeof subject === 'string' && subject !== '' ? subject : undefined
}
