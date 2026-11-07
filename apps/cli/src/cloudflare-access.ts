import { type CloudflareCall, zoneOf } from './cloudflare.ts'

type IdentityProvider = { id: string; type: string }
type AccessApp = { id: string; saas_app: { client_id: string; client_secret: string } }
type RoutingAddress = { email: string; verified: string | null }
type RoutingRule = { id: string; matchers: { type: string; field?: string; value?: string }[] }

export type OidcProvider = { issuer: string; clientId: string; clientSecret: string }

export const createAccessOidcApp = async (
  call: CloudflareCall,
  { hostname, origin, ownerEmail, name }: { hostname: string; origin: string; ownerEmail: string; name: string },
): Promise<OidcProvider> => {
  const zone = await zoneOf(call, hostname)
  const accounts = `/accounts/${zone.account.id}/access`
  const { auth_domain: teamDomain } = await call<{ auth_domain: string }>('GET', `${accounts}/organizations`)
  const providers = await call<IdentityProvider[]>('GET', `${accounts}/identity_providers`)
  const pin =
    providers.find((provider) => provider.type === 'onetimepin') ??
    (await call<IdentityProvider>('POST', `${accounts}/identity_providers`, {
      type: 'onetimepin',
      name: 'One-time PIN',
      config: {},
    }))
  const policy = await call<{ id: string }>('POST', `${accounts}/policies`, {
    name: `${name}: people at ${zone.name}`,
    decision: 'allow',
    include: [{ email_domain: { domain: zone.name } }, { email: { email: ownerEmail } }],
  })
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
  }
}

export const routeAdminMail = async (
  call: CloudflareCall,
  { hostname, ownerEmail }: { hostname: string; ownerEmail: string },
) => {
  const zone = await zoneOf(call, hostname)
  const adminAddress = `admin@${zone.name}`
  await call('POST', `/zones/${zone.id}/email/routing/enable`, {})
  const addresses = await call<RoutingAddress[]>('GET', `/accounts/${zone.account.id}/email/routing/addresses`)
  const destination =
    addresses.find((address) => address.email === ownerEmail) ??
    (await call<RoutingAddress>('POST', `/accounts/${zone.account.id}/email/routing/addresses`, { email: ownerEmail }))
  const rules = await call<RoutingRule[]>('GET', `/zones/${zone.id}/email/routing/rules`)
  const isRouted = rules.some((rule) =>
    rule.matchers.some((matcher) => matcher.field === 'to' && matcher.value === adminAddress),
  )
  if (!isRouted)
    await call('POST', `/zones/${zone.id}/email/routing/rules`, {
      name: `${adminAddress} to ${ownerEmail}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: adminAddress }],
      actions: [{ type: 'forward', value: [ownerEmail] }],
    })
  return { adminAddress, awaitsConfirmation: destination.verified === null }
}
