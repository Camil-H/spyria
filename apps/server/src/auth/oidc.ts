import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'

export type OidcSettings = { issuer: string; clientId: string; redirectUri: string }
type ClientSettings = OidcSettings & {
  clientSecret?: string
  emailOf?: (claims: JWTPayload) => string | undefined
}
type LoginState = { state: string; nonce: string; codeVerifier: string }

const idTokenClockToleranceSeconds = 30

const insecureOptionOf = (issuerUrl: URL) => ({ [oauth.allowInsecureRequests]: issuerUrl.protocol === 'http:' })

export const discoverIssuer = async (issuer: string) => {
  const issuerUrl = new URL(issuer)
  const response = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc', ...insecureOptionOf(issuerUrl) })
  return oauth.processDiscoveryResponse(issuerUrl, response)
}

const verifiedEmailOf = (claims: JWTPayload) =>
  claims.email_verified === true && typeof claims.email === 'string' ? claims.email : undefined

export const createOidc = ({
  issuer,
  clientId,
  redirectUri,
  clientSecret,
  emailOf = verifiedEmailOf,
}: ClientSettings) => {
  const client: oauth.Client = { client_id: clientId }
  const clientAuthentication = clientSecret ? oauth.ClientSecretPost(clientSecret) : oauth.None()
  let discovery: Promise<{ server: oauth.AuthorizationServer; keys: ReturnType<typeof createRemoteJWKSet> }> | undefined
  const discover = () => {
    discovery ??= discoverIssuer(issuer)
      .then((server) => ({ server, keys: createRemoteJWKSet(new URL(server.jwks_uri ?? '')) }))
      .catch((error) => {
        discovery = undefined
        throw error
      })
    return discovery
  }
  return {
    authorizationUrl: async () => {
      const { server } = await discover()
      const login: LoginState = {
        state: oauth.generateRandomState(),
        nonce: oauth.generateRandomNonce(),
        codeVerifier: oauth.generateRandomCodeVerifier(),
      }
      const url = new URL(server.authorization_endpoint ?? '')
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: await oauth.calculatePKCECodeChallenge(login.codeVerifier),
        code_challenge_method: 'S256',
        state: login.state,
        nonce: login.nonce,
      }).toString()
      return { url: url.href, login }
    },
    verifiedIdentityOf: async (callbackUrl: URL, login: LoginState) => {
      const { server, keys } = await discover()
      const parameters = oauth.validateAuthResponse(server, client, callbackUrl, login.state)
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        client,
        clientAuthentication,
        parameters,
        redirectUri,
        login.codeVerifier,
        insecureOptionOf(new URL(issuer)),
      )
      const result = await oauth.processAuthorizationCodeResponse(server, client, response, {
        expectedNonce: login.nonce,
        requireIdToken: true,
      })
      const { payload } = await jwtVerify(result.id_token ?? '', keys, {
        issuer: server.issuer,
        audience: clientId,
        clockTolerance: idTokenClockToleranceSeconds,
      })
      const email = emailOf(payload)
      if (payload.nonce !== login.nonce || email === undefined || typeof payload.sub !== 'string')
        throw new Error('The ID token carries no trusted email for this login')
      return { email, name: payload.name, issuer: server.issuer, subject: payload.sub }
    },
  }
}

export type Oidc = ReturnType<typeof createOidc>
