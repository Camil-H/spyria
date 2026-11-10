import { withRetries } from '@spyria/kernel'
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'

export type OidcSettings = { issuer: string; clientId: string; redirectUri: string }
export type EmailRefusal = 'unconfirmed' | 'untrusted'
export type EmailClaim = { email: string; refusal?: undefined } | { email?: undefined; refusal: EmailRefusal }
export class EmailRefused extends Error {
  readonly refusal: EmailRefusal
  constructor(refusal: EmailRefusal) {
    super(`The ID token carries no trusted email for this login: ${refusal}`)
    this.refusal = refusal
  }
}
type ClientSettings = OidcSettings & {
  clientSecret?: string
  emailOf?: (claims: JWTPayload) => EmailClaim
  subjectOf?: (claims: JWTPayload) => string | undefined
  canBindByEmailOf?: (claims: JWTPayload) => boolean
}
type LoginState = { state: string; nonce: string; codeVerifier: string }

const idTokenClockToleranceSeconds = 30
const providerTimeoutMilliseconds = 10_000

const insecureOptionOf = (issuerUrl: URL) => ({ [oauth.allowInsecureRequests]: issuerUrl.protocol === 'http:' })

export const discoverIssuer = async (issuer: string) => {
  const issuerUrl = new URL(issuer)
  const response = await oauth.discoveryRequest(issuerUrl, {
    algorithm: 'oidc',
    ...insecureOptionOf(issuerUrl),
    [oauth.customFetch]: (url, options) =>
      withRetries((signal) => fetch(url, { ...options, signal }), { timeoutMilliseconds: providerTimeoutMilliseconds }),
  })
  return oauth.processDiscoveryResponse(issuerUrl, response)
}

const verifiedEmailOf = (claims: JWTPayload): EmailClaim => {
  if (typeof claims.email !== 'string') return { refusal: 'untrusted' }
  return claims.email_verified === true ? { email: claims.email } : { refusal: 'unconfirmed' }
}

export const createOidc = ({
  issuer,
  clientId,
  redirectUri,
  clientSecret,
  emailOf = verifiedEmailOf,
  subjectOf = (claims) => claims.sub,
  canBindByEmailOf = () => true,
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
        { ...insecureOptionOf(new URL(issuer)), signal: AbortSignal.timeout(providerTimeoutMilliseconds) },
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
      const claimed = emailOf(payload)
      const subject = subjectOf(payload)
      if (payload.nonce !== login.nonce || typeof subject !== 'string' || subject === '')
        throw new Error('The ID token carries no trusted subject for this login')
      if (claimed.refusal) throw new EmailRefused(claimed.refusal)
      const { email } = claimed
      const legacySubject = typeof payload.sub === 'string' && payload.sub !== subject ? payload.sub : undefined
      return {
        email,
        name: payload.name,
        issuer: server.issuer,
        subject,
        legacySubject,
        canBindByEmail: canBindByEmailOf(payload),
      }
    },
  }
}

export type Oidc = ReturnType<typeof createOidc>
