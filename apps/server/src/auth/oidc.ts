import { createRemoteJWKSet, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'

export type OidcSettings = { issuer: string; clientId: string; redirectUri: string }
type LoginState = { state: string; nonce: string; codeVerifier: string }

const idTokenClockToleranceSeconds = 30

export const createOidc = ({ issuer, clientId, redirectUri }: OidcSettings) => {
  const issuerUrl = new URL(issuer)
  const insecureOption = { [oauth.allowInsecureRequests]: issuerUrl.protocol === 'http:' }
  const client: oauth.Client = { client_id: clientId }
  let discovery: Promise<{ server: oauth.AuthorizationServer; keys: ReturnType<typeof createRemoteJWKSet> }> | undefined
  const discover = () => {
    discovery ??= oauth
      .discoveryRequest(issuerUrl, { algorithm: 'oidc', ...insecureOption })
      .then((response) => oauth.processDiscoveryResponse(issuerUrl, response))
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
        scope: 'openid email',
        code_challenge: await oauth.calculatePKCECodeChallenge(login.codeVerifier),
        code_challenge_method: 'S256',
        state: login.state,
        nonce: login.nonce,
      }).toString()
      return { url: url.href, login }
    },
    verifiedEmailOf: async (callbackUrl: URL, login: LoginState) => {
      const { server, keys } = await discover()
      const parameters = oauth.validateAuthResponse(server, client, callbackUrl, login.state)
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        client,
        oauth.None(),
        parameters,
        redirectUri,
        login.codeVerifier,
        insecureOption,
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
      if (payload.nonce !== login.nonce || payload.email_verified !== true || typeof payload.email !== 'string')
        throw new Error('The ID token carries no verified email for this login')
      return payload.email
    },
  }
}

export type Oidc = ReturnType<typeof createOidc>
