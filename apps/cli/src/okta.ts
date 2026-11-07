export class OktaRefused extends Error {}

export const registerOktaApp = async ({
  orgUrl,
  apiToken,
  origin,
}: {
  orgUrl: string
  apiToken: string
  origin: string
}) => {
  const org = new URL(orgUrl).origin
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
  const app = await call<{ id: string; credentials: { oauthClient: { client_id: string; client_secret: string } } }>(
    'POST',
    '/api/v1/apps',
    {
      name: 'oidc_client',
      label: `Spyria ${new URL(origin).hostname}`,
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
    },
  )
  const [everyone] = await call<{ id: string }[]>('GET', `/api/v1/groups?${new URLSearchParams({ q: 'Everyone' })}`)
  if (everyone) await call('PUT', `/api/v1/apps/${app.id}/groups/${everyone.id}`, {})
  return {
    issuer: org,
    clientId: app.credentials.oauthClient.client_id,
    clientSecret: app.credentials.oauthClient.client_secret,
  }
}
