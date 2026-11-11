import { InvalidSsoSettings } from './errors.ts'

export const ssoPresets = ['google', 'microsoft', 'oidc'] as const
export type SsoPreset = (typeof ssoPresets)[number]
export type SignInScope = 'account' | 'workspace'
export type SsoSettingsInput = {
  preset: SsoPreset
  issuer?: string
  tenantId?: string
  clientId: string
  clientSecret?: string
  usesInstanceApp?: boolean
}
export type SsoSettings = { preset: SsoPreset; issuer: string; clientId: string }
export type SsoSettingsView = SsoSettings & { tenantId: string; hasSecret: boolean; usesInstanceApp: boolean }
export type SsoEmail =
  | { email: string; refusal?: undefined }
  | { email?: undefined; refusal: 'unconfirmed' | 'untrusted' }
export const instanceAppPresets = ['google', 'microsoft'] as const
export type InstanceAppPreset = (typeof instanceAppPresets)[number]
export type InstanceApp = { clientId: string; clientSecret: string }
export type InstanceApps = Partial<Record<InstanceAppPreset, InstanceApp>> & { oidc?: InstanceApp & { issuer: string } }
export const accountProviders = ['google', 'microsoft', 'oidc'] as const
export type AccountProvider = (typeof accountProviders)[number]

export const googleIssuer = 'https://accounts.google.com'
export const microsoftLoginOrigin = 'https://login.microsoftonline.com'
export const microsoftPersonalAccountsTenantId = '9188040d-6c67-4c5b-b112-36a304b66dad'
const multiTenantSegments = new Set(['common', 'organizations', 'consumers'])
const tenantIdPattern = /^[\w.-]+$/
const gmailDomains = new Set(['gmail.com', 'googlemail.com'])

const domainOfEmail = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

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

export const ssoSettingsFrom = (input: SsoSettingsInput, microsoftOrigin = microsoftLoginOrigin): SsoSettings => {
  if (!ssoPresets.includes(input.preset)) throw new InvalidSsoSettings(`${input.preset} is not a provider preset`)
  const issuer = issuerOf(input, microsoftOrigin)
  const isEntra = input.preset === 'microsoft' || issuer.startsWith(microsoftLoginOrigin)
  if (isEntra && multiTenantSegments.has(tenantIdOf(issuer).toLowerCase()))
    throw new InvalidSsoSettings('Only a tenant-specific Microsoft Entra issuer is accepted')
  const clientId = String(input.clientId ?? '').trim()
  if (clientId === '') throw new InvalidSsoSettings('A client id is required')
  return { preset: input.preset, issuer, clientId }
}

const addressOf = (value: unknown) => (typeof value === 'string' && value.includes('@') ? value : undefined)

const confirmedEmailOf = (claims: Record<string, unknown>): SsoEmail => {
  const email = addressOf(claims.email)
  if (email === undefined) return { refusal: 'untrusted' }
  return claims.email_verified === true ? { email } : { refusal: 'unconfirmed' }
}

const googleEmailOf = (claims: Record<string, unknown>, scope: SignInScope): SsoEmail => {
  const confirmed = confirmedEmailOf(claims)
  if (confirmed.refusal || scope === 'account') return confirmed
  const domain = domainOfEmail(confirmed.email)
  const isManagedByGoogle = claims.hd === undefined ? gmailDomains.has(domain) : claims.hd === domain
  return isManagedByGoogle ? confirmed : { refusal: 'untrusted' }
}

export const ssoEmailOf = (preset: SsoPreset, claims: Record<string, unknown>, scope: SignInScope): SsoEmail => {
  if (preset === 'google') return googleEmailOf(claims, scope)
  if (preset === 'oidc') return confirmedEmailOf(claims)
  const email = addressOf(scope === 'account' ? claims.preferred_username : (claims.preferred_username ?? claims.email))
  return email === undefined ? { refusal: 'untrusted' } : { email }
}

export const entraObjectIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const ssoCanBindByEmail = (preset: SsoPreset, claims: Record<string, unknown>) =>
  preset !== 'microsoft' ||
  typeof claims.idp !== 'string' ||
  claims.idp === claims.iss ||
  claims.tid === microsoftPersonalAccountsTenantId

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

export const accountProvidersOf = (instanceApps: InstanceApps) =>
  accountProviders.filter((provider) => instanceApps[provider] !== undefined)

export const accountIssuerOf = (
  provider: AccountProvider,
  instanceApps: InstanceApps,
  microsoftOrigin = microsoftLoginOrigin,
) => {
  if (provider === 'google') return googleIssuer
  if (provider === 'microsoft') return `${microsoftOrigin}/common/v2.0`
  return instanceApps.oidc?.issuer.replace(/\/$/, '') ?? ''
}

export const ssoSubjectOf = (preset: SsoPreset, claims: Record<string, unknown>) => {
  const subject = preset === 'microsoft' ? claims.oid : claims.sub
  return typeof subject === 'string' && subject !== '' ? subject : undefined
}
