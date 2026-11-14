export class OktaRefused extends Error {}

type OktaApp = {
  id: string
  label: string
  status: string
  credentials: { oauthClient: { client_id: string; client_secret?: string } }
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])

const carriesTokenSafely = ({ protocol, hostname }: URL) =>
  protocol === 'https:' || (protocol === 'http:' && loopbackHostnames.has(hostname))

const newAppOf = (label: string, origin: string) => ({
  name: 'oidc_client',
  label,
  signOnMode: 'OPENID_CONNECT',
  credentials: { oauthClient: { token_endpoint_auth_method: 'client_secret_post' } },
  settings: {
    oauthClient: {
      application_type: 'web',
      redirect_uris: [`${origin}/auth/callback`],
      response_types: ['code'],
      grant_types: ['authorization_code'],
    },
  },
})

export const registerOktaApp = async ({
  orgUrl,
  apiToken,
  origin,
}: {
  orgUrl: string
  apiToken: string
  origin: string
}) => {
  const orgAddress = new URL(orgUrl)
  if (!carriesTokenSafely(orgAddress))
    throw new OktaRefused('The Okta organization URL must start with https://, so the API token never travels in clear')
  const org = orgAddress.origin.replace(/-admin(\.(?:okta|oktapreview)\.com)$/, '$1')
  const call = async <Result>(method: string, path: string, body?: object): Promise<Result> => {
    const response = await fetch(`${org}${path}`, {
      method,
      headers: { authorization: `SSWS ${apiToken}`, accept: 'application/json', 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const answer = (await response.json().catch(() => ({}))) as Result & { errorSummary?: string }
    if (!response.ok)
      throw new OktaRefused(`Okta refused ${method} ${path.split('?')[0]}: ${answer.errorSummary ?? response.status}`)
    return answer
  }
  const label = `Spyria ${new URL(origin).hostname}`
  const appsFound = await call<OktaApp[]>('GET', `/api/v1/apps?${new URLSearchParams({ q: label })}`)
  const earlierApp = appsFound.find((candidate) => candidate.label === label && candidate.status === 'ACTIVE')
  const app = earlierApp ?? (await call<OktaApp>('POST', '/api/v1/apps', newAppOf(label, origin)))
  const clientSecret = earlierApp
    ? (await call<{ client_secret: string }>('POST', `/api/v1/apps/${earlierApp.id}/credentials/secrets`, {}))
        .client_secret
    : app.credentials.oauthClient.client_secret
  if (!clientSecret) throw new OktaRefused(`Okta did not return a client secret for the app ${label}`)
  const builtInGroups = await call<{ id: string; profile: { name: string } }[]>(
    'GET',
    `/api/v1/groups?${new URLSearchParams({ search: 'type eq "BUILT_IN"' })}`,
  )
  const everyone = builtInGroups.find((group) => group.profile.name === 'Everyone')
  if (!everyone)
    throw new OktaRefused('Okta has no Everyone group to assign the app to: assign it to your people by hand')
  await call('PUT', `/api/v1/apps/${app.id}/groups/${everyone.id}`, {})
  return { issuer: org, clientId: app.credentials.oauthClient.client_id, clientSecret }
}
