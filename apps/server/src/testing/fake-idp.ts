import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'

export const commonPath = '/common/v2.0'
const nowInSeconds = () => Math.floor(Date.now() / 1000)

export const startFakeIdp = async (issuerPath = '', { confirmsEmail = true } = {}) => {
  const keys = await generateKeyPair('RS256')
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'fake-idp', alg: 'RS256', use: 'sig' }
  const idp = {
    claimsByCode: new Map<string, JWTPayload>(),
    clientSecrets: {} as Record<string, string>,
    requests: [] as string[],
    tokenRequests: [] as URLSearchParams[],
  }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, origin } = new URL(request.url)
      idp.requests.push(pathname)
      const basePath = [commonPath, issuerPath].find((path) => pathname.startsWith(`${path}/`))
      if (basePath === undefined) return new Response(null, { status: 404 })
      const endpoint = `${origin}${basePath}`
      const isCommon = basePath === commonPath
      const route = pathname.slice(basePath.length)
      if (route === '/.well-known/openid-configuration')
        return Response.json({
          issuer: isCommon ? `${origin}/{tenantid}/v2.0` : endpoint,
          authorization_endpoint: `${endpoint}/auth`,
          token_endpoint: `${endpoint}/token`,
          jwks_uri: `${endpoint}/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        })
      if (route === '/keys') return Response.json({ keys: [publicKey] })
      if (route !== '/token') return new Response(null, { status: 404 })
      const form = new URLSearchParams(await request.text())
      idp.tokenRequests.push(form)
      if (form.get('client_secret') !== idp.clientSecrets[form.get('client_id') ?? ''])
        return Response.json({ error: 'invalid_client' }, { status: 401 })
      const claims = idp.claimsByCode.get(form.get('code') ?? '') ?? {}
      const idToken = await new SignJWT({
        iss: isCommon ? `${origin}/${claims.tid}/v2.0` : endpoint,
        aud: form.get('client_id') ?? '',
        iat: nowInSeconds(),
        exp: nowInSeconds() + 60,
        ...(confirmsEmail && { email_verified: true }),
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-idp' })
        .sign(keys.privateKey)
      return Response.json({ access_token: 'access', token_type: 'Bearer', id_token: idToken })
    },
  })
  return Object.assign(idp, { origin: server.url.origin, issuer: `${server.url.origin}${issuerPath}`, server })
}
export type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>
