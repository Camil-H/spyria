import { type CloudflareCall, CloudflareRefused, zoneOf } from './cloudflare.ts'

type IdentityProvider = { id: string; type: string }
type Named = { id: string; name: string }
type AccessApp = Named & { saas_app: { client_id: string; client_secret: string } }
type RoutingAddress = { email: string; verified: string | null }
type RoutingRule = {
  id: string
  matchers: { type: string; field?: string; value?: string }[]
  actions: { value?: string[] }[]
}
type DnsRecord = { content: string }

export type OidcProvider = { issuer: string; clientId: string; clientSecret: string }

const cloudflareMailServerPattern = /\.mx\.cloudflare\.net\.?$/

export const createAccessOidcApp = async (
  call: CloudflareCall,
  { hostname, origin, name }: { hostname: string; origin: string; name: string },
): Promise<OidcProvider & { domain: string }> => {
  const zone = await zoneOf(call, hostname)
  const accounts = `/accounts/${zone.account.id}/access`
  const { auth_domain: teamDomain } = await call<{ auth_domain: string }>('GET', `${accounts}/organizations`)
  const apps = await call<Named[]>('GET', `${accounts}/apps`)
  if (apps.some((app) => app.name === name))
    throw new CloudflareRefused(
      `An Access application named ${name} exists already and its secret cannot be read back: delete it in Zero Trust > Access > Applications, or choose another provider`,
    )
  const providers = await call<IdentityProvider[]>('GET', `${accounts}/identity_providers`)
  const pin =
    providers.find((provider) => provider.type === 'onetimepin') ??
    (await call<IdentityProvider>('POST', `${accounts}/identity_providers`, {
      type: 'onetimepin',
      name: 'One-time PIN',
      config: {},
    }))
  const policyName = `${name}: people at ${zone.name}`
  const policies = await call<Named[]>('GET', `${accounts}/policies`)
  const policy =
    policies.find((candidate) => candidate.name === policyName) ??
    (await call<Named>('POST', `${accounts}/policies`, {
      name: policyName,
      decision: 'allow',
      include: [{ email_domain: { domain: zone.name } }],
    }))
  const app = await call<AccessApp>('POST', `${accounts}/apps`, {
    name,
    type: 'saas',
    allowed_idps: [pin.id],
    auto_redirect_to_identity: true,
    policies: [{ id: policy.id, precedence: 1 }],
    saas_app: {
      auth_type: 'oidc',
      redirect_uris: [`${origin}/auth/callback`],
      grant_types: ['authorization_code_with_pkce'],
      scopes: ['openid', 'email', 'profile'],
    },
  })
  return {
    issuer: `https://${teamDomain}/cdn-cgi/access/sso/oidc/${app.saas_app.client_id}`,
    clientId: app.saas_app.client_id,
    clientSecret: app.saas_app.client_secret,
    domain: zone.name,
  }
}

export const routeAdminMail = async (
  call: CloudflareCall,
  { hostname, ownerEmail }: { hostname: string; ownerEmail: string },
) => {
  const zone = await zoneOf(call, hostname)
  const adminAddress = `admin@${zone.name}`
  const mailServers = await call<DnsRecord[]>(
    'GET',
    `/zones/${zone.id}/dns_records?${new URLSearchParams({ name: zone.name, type: 'MX' })}`,
  )
  if (mailServers.some(({ content }) => !cloudflareMailServerPattern.test(content)))
    return { adminAddress, outcome: 'has_mailboxes' as const }
  await call('POST', `/zones/${zone.id}/email/routing/dns`, {})
  const addresses = await call<RoutingAddress[]>('GET', `/accounts/${zone.account.id}/email/routing/addresses`)
  const destination =
    addresses.find((address) => address.email === ownerEmail) ??
    (await call<RoutingAddress>('POST', `/accounts/${zone.account.id}/email/routing/addresses`, { email: ownerEmail }))
  const rules = await call<RoutingRule[]>('GET', `/zones/${zone.id}/email/routing/rules`)
  const existingRule = rules.find((rule) =>
    rule.matchers.some((matcher) => matcher.field === 'to' && matcher.value === adminAddress),
  )
  if (existingRule && !existingRule.actions.some((action) => action.value?.includes(ownerEmail)))
    return { adminAddress, outcome: 'routed_elsewhere' as const }
  if (!existingRule)
    await call('POST', `/zones/${zone.id}/email/routing/rules`, {
      name: `${adminAddress} to ${ownerEmail}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: adminAddress }],
      actions: [{ type: 'forward', value: [ownerEmail] }],
    })
  return {
    adminAddress,
    outcome: destination.verified === null ? ('awaits_confirmation' as const) : ('routed' as const),
  }
}
