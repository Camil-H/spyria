import { InvalidSsoSettings } from './errors.ts'

export const ssoPresets = ['google', 'microsoft', 'oidc'] as const
export type SsoPreset = (typeof ssoPresets)[number]
export type SsoSettingsInput = {
  preset: SsoPreset
  issuer?: string
  tenantId?: string
  clientId: string
  clientSecret?: string
  domains: string[]
}
export type SsoSettings = { preset: SsoPreset; issuer: string; clientId: string; domains: string[] }
export type SsoSettingsView = SsoSettings & { tenantId: string; hasSecret: boolean }

export const googleIssuer = 'https://accounts.google.com'
export const microsoftLoginOrigin = 'https://login.microsoftonline.com'
const multiTenantSegments = new Set(['common', 'organizations', 'consumers'])
const tenantIdPattern = /^[\w.-]+$/
const domainPattern = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

export const domainOfEmail = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

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
  const domains = [
    ...new Set(
      (Array.isArray(input.domains) ? input.domains : []).map((domain) =>
        String(domain).trim().toLowerCase().replace(/^@/, ''),
      ),
    ),
  ].filter(Boolean)
  if (domains.length === 0) throw new InvalidSsoSettings('At least one email domain is required')
  const invalidDomain = domains.find((domain) => !domainPattern.test(domain))
  if (invalidDomain) throw new InvalidSsoSettings(`${invalidDomain} is not an email domain`)
  return { preset: input.preset, issuer, clientId, domains }
}

export const ssoEmailOf = (preset: SsoPreset, claims: Record<string, unknown>) => {
  const email = preset === 'microsoft' ? (claims.email ?? claims.preferred_username) : claims.email
  return typeof email === 'string' && email.includes('@') ? email : undefined
}
