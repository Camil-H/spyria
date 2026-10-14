import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createApp } from '../app.ts'
import { acme, globex, testAuthSettings } from '../testing.ts'
import { issueSessionToken } from './session-tokens.ts'
import { openSessions } from './sessions.ts'

const testDatabase = await createTestDatabase()
const otherDatabase = await createTestDatabase()
const { database } = testDatabase

const idpKeys = await generateKeyPair('RS256')
const idpPublicKey = { ...(await exportJWK(idpKeys.publicKey)), kid: 'fake-idp', alg: 'RS256', use: 'sig' }
let nextIdToken = ''
const idp = Bun.serve({
  port: 0,
  fetch: (request) => {
    const { pathname, origin } = new URL(request.url)
    if (pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/auth`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/keys`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      })
    if (pathname === '/keys') return Response.json({ keys: [idpPublicKey] })
    if (pathname === '/token')
      return Response.json({ access_token: 'access', token_type: 'Bearer', id_token: nextIdToken })
    return new Response(null, { status: 404 })
  },
})
const idpIssuer = idp.url.origin
const appOrigin = testAuthSettings.appOrigin
const settingsWithIdp = { ...testAuthSettings, oidc: { ...testAuthSettings.oidc, issuer: idpIssuer } }
const app = createApp({ database, ...settingsWithIdp })
afterAll(async () => {
  await idp.stop(true)
  await testDatabase.drop()
  await otherDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const nowInSeconds = () => Math.floor(Date.now() / 1000)

const signIdToken = (claims: JWTPayload) =>
  new SignJWT({
    iss: idpIssuer,
    aud: testAuthSettings.oidc.clientId,
    sub: 'subject-1',
    iat: nowInSeconds(),
    exp: nowInSeconds() + 60,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fake-idp' })
    .sign(idpKeys.privateKey)

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')

const startLogin = async (path = '/auth/login') => {
  const response = await app.request(path)
  const location = new URL(response.headers.get('location') ?? '')
  return {
    status: response.status,
    location,
    cookie: cookieHeaderOf(response),
    state: location.searchParams.get('state') ?? '',
    nonce: location.searchParams.get('nonce') ?? '',
  }
}

const callback = (state: string, cookie: string) =>
  app.request(`/auth/callback?code=code-1&state=${state}`, { headers: { cookie } })

type IdTokenOf = (nonce: string) => Promise<string>
const signInWith = async (idTokenOf: IdTokenOf, loginPath?: string) => {
  const login = await startLogin(loginPath)
  nextIdToken = await idTokenOf(login.nonce)
  const response = await callback(login.state, login.cookie)
  return { status: response.status, page: await response.text(), cookie: cookieHeaderOf(response) }
}
const verifiedEmail = (email: string) => (nonce: string) => signIdToken({ nonce, email, email_verified: true })
const signInAs = (email: string, loginPath?: string) => signInWith(verifiedEmail(email), loginPath)

const sessionsOf = async (cookie: string, server = app) =>
  (await (await server.request('/auth/sessions', { headers: { cookie } })).json()) as {
    userId?: string
    sessions: { workspaceId: string; token: string; role: string; expiresAt: number }[]
  }

const queryWith = (token: string) =>
  app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', [{ id: 'chats', name: 'chats', args: [] }]]),
  })

const sameAppHeaders = { origin: appOrigin, 'x-hq-csrf': '1', 'content-type': 'application/json' }
const postAuth = (path: string, cookie: string, body: object, headers: Record<string, string> = sameAppHeaders) =>
  app.request(path, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(body) })

test('login redirects to the IdP with PKCE, state and nonce', async () => {
  const login = await startLogin()
  expect(login.status).toBe(302)
  expect(login.location.origin).toBe(idpIssuer)
  expect(Object.fromEntries(login.location.searchParams)).toMatchObject({
    client_id: 'hq',
    redirect_uri: testAuthSettings.oidc.redirectUri,
    response_type: 'code',
    code_challenge_method: 'S256',
  })
  expect(login.location.searchParams.get('code_challenge')?.length).toBeGreaterThan(40)
  expect(login.cookie).toContain('hq_login=')
})

test('a verified email of a member opens a session in each of their workspaces', async () => {
  const signIn = await signInAs('alice@example.com')
  expect(signIn.status).toBe(200)
  expect(signIn.page).toContain('"status":"signed_in"')
  expect(signIn.page).toContain(JSON.stringify(appOrigin))
  const { userId, sessions } = await sessionsOf(signIn.cookie)
  expect(userId).toBe('member-alice')
  expect(sessions.map(({ workspaceId, role }) => ({ workspaceId, role }))).toEqual([
    { workspaceId: acme, role: 'admin' },
    { workspaceId: globex, role: 'admin' },
  ])
  for (const session of sessions) expect((await queryWith(session.token)).status).toBe(200)
})

test('a login for one workspace opens only that session', async () => {
  const signIn = await signInAs('alice@example.com', `/auth/login?workspace=${globex}`)
  expect((await sessionsOf(signIn.cookie)).sessions.map((session) => session.workspaceId)).toEqual([globex])
})

test('an email without any membership is not invited and opens nothing', async () => {
  const signIn = await signInAs('nina@example.com')
  expect(signIn.status).toBe(403)
  expect(signIn.page).toContain('"status":"not_invited"')
  expect(signIn.page).toContain('nina@example.com')
  expect(signIn.cookie).not.toContain('hq_s_')
})

test.each<[string, (nonce: string, previousNonce: string) => Promise<string>]>([
  ['a missing nonce', () => signIdToken({ email: 'alice@example.com', email_verified: true })],
  [
    'a nonce reused from another login',
    (_, previousNonce) => signIdToken({ nonce: previousNonce, email: 'alice@example.com', email_verified: true }),
  ],
  [
    'a wrong issuer',
    (nonce) => signIdToken({ nonce, email: 'alice@example.com', email_verified: true, iss: 'http://localhost:1/evil' }),
  ],
  ['a wrong audience', (nonce) => signIdToken({ nonce, email: 'alice@example.com', email_verified: true, aud: 'x' })],
  [
    'an expired ID token',
    (nonce) => signIdToken({ nonce, email: 'alice@example.com', email_verified: true, exp: nowInSeconds() - 120 }),
  ],
  [
    'a tampered ID token',
    async (nonce) => {
      const [header, , signature] = (
        await signIdToken({ nonce, email: 'bob@example.com', email_verified: true })
      ).split('.')
      const payload = { nonce, email: 'alice@example.com', email_verified: true, iss: idpIssuer, aud: 'hq', sub: 's' }
      return `${header}.${Buffer.from(JSON.stringify({ ...payload, exp: nowInSeconds() + 60, iat: nowInSeconds() })).toString('base64url')}.${signature}`
    },
  ],
  [
    'a token signed by another key',
    async (nonce) =>
      new SignJWT({ nonce, email: 'alice@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-idp' })
        .setIssuer(idpIssuer)
        .setAudience('hq')
        .setSubject('subject-1')
        .setIssuedAt()
        .setExpirationTime(nowInSeconds() + 60)
        .sign((await generateKeyPair('RS256')).privateKey),
  ],
  ['an unverified email', (nonce) => signIdToken({ nonce, email: 'alice@example.com', email_verified: false })],
])('the callback refuses %s', async (_, idTokenOf) => {
  const previousLogin = await startLogin()
  const signIn = await signInWith((nonce) => idTokenOf(nonce, previousLogin.nonce))
  expect(signIn.status).toBe(400)
  expect(signIn.page).toContain('"status":"failed"')
  expect(signIn.cookie).not.toContain('hq_s_')
})

test('the callback refuses a wrong state, a missing login cookie and a tampered login cookie', async () => {
  const login = await startLogin()
  nextIdToken = await signIdToken({ nonce: login.nonce, email: 'alice@example.com', email_verified: true })
  const tamperedCookie = login.cookie.replace(/hq_login=([^;]*)/, (_, value) => `hq_login=x${value}`)
  for (const response of [
    await callback('wrong-state', login.cookie),
    await callback(login.state, ''),
    await callback(login.state, tamperedCookie),
  ]) {
    expect(response.status).toBe(400)
    expect(cookieHeaderOf(response)).not.toContain('hq_s_')
  }
})

test('the API refuses a revoked session at once, even with an unexpired token', async () => {
  const { cookie } = await signInAs('alice@example.com')
  const [acmeSession] = (await sessionsOf(cookie)).sessions
  expect((await postAuth('/auth/logout', cookie, { workspaceId: acme })).status).toBe(204)
  expect((await queryWith(acmeSession?.token ?? '')).status).toBe(401)
  expect((await sessionsOf(cookie)).sessions.map((session) => session.workspaceId)).toEqual([globex])
})

test('the API refuses a removed membership at once, even with an unexpired token', async () => {
  await database.$client`insert into users (id, email) values ('member-dana', 'dana@example.com')`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${acme}, 'member-dana', 'member', 'Dana')`
  const [danaSession] = (await sessionsOf((await signInAs('dana@example.com')).cookie)).sessions
  expect((await queryWith(danaSession?.token ?? '')).status).toBe(200)
  await database.$client`delete from memberships where user_id = 'member-dana'`
  expect((await queryWith(danaSession?.token ?? '')).status).toBe(403)
})

test('a token naming another workspace than its session is refused', async () => {
  const [bobInAcme] = await openSessions(database, 'member-bob', acme)
  if (!bobInAcme) throw new Error('Bob has no Acme session')
  const forged = await issueSessionToken(testAuthSettings.tokenSecret, { ...bobInAcme, workspaceId: globex })
  expect((await queryWith(forged.token)).status).toBe(403)
  const aliceForged = await issueSessionToken(testAuthSettings.tokenSecret, {
    ...bobInAcme,
    userId: 'member-alice',
    workspaceId: globex,
  })
  expect((await queryWith(aliceForged.token)).status).toBe(401)
})

test('renewal issues a new token from the session cookie', async () => {
  const { cookie } = await signInAs('alice@example.com')
  const response = await postAuth('/auth/renew', cookie, { workspaceId: acme })
  expect(response.status).toBe(200)
  const renewed = (await response.json()) as { workspaceId: string; token: string; expiresAt: number }
  expect(renewed.workspaceId).toBe(acme)
  expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 14 * 60 * 1000)
  expect((await queryWith(renewed.token)).status).toBe(200)
})

test('renewal is refused without the CSRF header, from another origin, without a cookie and after logout', async () => {
  const { cookie } = await signInAs('alice@example.com')
  const { 'x-hq-csrf': _, ...withoutCsrf } = sameAppHeaders
  expect((await postAuth('/auth/renew', cookie, { workspaceId: acme }, withoutCsrf)).status).toBe(403)
  expect(
    (await postAuth('/auth/renew', cookie, { workspaceId: acme }, { ...sameAppHeaders, origin: 'http://evil.test' }))
      .status,
  ).toBe(403)
  expect((await postAuth('/auth/renew', '', { workspaceId: acme })).status).toBe(401)
  expect((await postAuth('/auth/logout', cookie, { workspaceId: acme }, withoutCsrf)).status).toBe(403)
  expect((await postAuth('/auth/logout', cookie, { workspaceId: acme })).status).toBe(204)
  expect((await postAuth('/auth/renew', cookie, { workspaceId: acme })).status).toBe(401)
  expect((await postAuth('/auth/renew', cookie, { workspaceId: globex })).status).toBe(200)
})

test('a new session for another workspace needs a bearer token of a member of both', async () => {
  const [aliceInAcme] = await openSessions(database, 'member-alice', acme)
  const [bobInAcme] = await openSessions(database, 'member-bob', acme)
  if (!aliceInAcme || !bobInAcme) throw new Error('missing session')
  const bearerOf = async (session: typeof aliceInAcme) =>
    `Bearer ${(await issueSessionToken(testAuthSettings.tokenSecret, session)).token}`
  const openFor = async (session: typeof aliceInAcme | undefined) =>
    app.request('/auth/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session && { authorization: await bearerOf(session) }) },
      body: JSON.stringify({ workspaceId: globex }),
    })
  expect((await openFor(undefined)).status).toBe(401)
  expect((await openFor(bobInAcme)).status).toBe(403)
  const opened = await openFor(aliceInAcme)
  expect(opened.status).toBe(200)
  expect(cookieHeaderOf(opened)).toContain(`hq_s_${globex}=`)
  expect((await queryWith(((await opened.json()) as { token: string }).token)).status).toBe(200)
})

test('Bob signed in through the IdP has a session in Acme only', async () => {
  const { sessions } = await sessionsOf((await signInAs('bob@example.com')).cookie)
  expect(sessions.map((session) => session.workspaceId)).toEqual([acme])
})

test('without test hooks the app ignores the hq_test cookie, the test routes and database claims', async () => {
  const [aliceInOther] = await openSessions(otherDatabase.database, 'member-alice', acme)
  if (!aliceInOther) throw new Error('missing session')
  const testCookie = `hq_test=${encodeURIComponent(JSON.stringify({ db: otherDatabase.name, user: 'member-alice', tokenSeconds: 1 }))}`
  const cookie = `${testCookie}; hq_s_${acme}=${aliceInOther.sessionId}`
  expect(await sessionsOf(cookie)).toEqual({ sessions: [] })
  const login = await startLogin()
  const loginWithTestCookie = await app.request('/auth/login', { headers: { cookie: testCookie } })
  expect(loginWithTestCookie.status).toBe(302)
  expect(new URL(loginWithTestCookie.headers.get('location') ?? '').origin).toBe(login.location.origin)
  for (const path of ['/test/sign-in', '/test/token', '/test/release-database'])
    expect((await app.request(`${path}?db=${otherDatabase.name}&user=member-alice`, { method: 'POST' })).status).toBe(
      404,
    )

  const testApp = createApp({ database, ...settingsWithIdp, testDatabaseByName: () => otherDatabase.database })
  const { sessions } = await sessionsOf(cookie, testApp)
  expect(sessions.map((session) => session.workspaceId)).toEqual([acme])
  expect(sessions[0]?.expiresAt).toBeLessThan(Date.now() + 2000)
})

test('signs in through the real Dex form', async () => {
  const dexApp = createApp({ database, ...testAuthSettings })
  const login = await dexApp.request('/auth/login')
  let location = login.headers.get('location') ?? ''
  for (let hop = 0; !location.startsWith(testAuthSettings.oidc.redirectUri); hop++) {
    if (hop === 10) throw new Error(`Dex did not redirect back, last location ${location}`)
    const page = await fetch(location, { redirect: 'manual' })
    location = page.headers.get('location') ?? ''
    if (page.status === 200) {
      const submitted = await fetch(page.url, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({ login: 'alice@example.com', password: 'password' }),
      })
      location = new URL(submitted.headers.get('location') ?? '', page.url).href
    } else location = new URL(location, page.url).href
  }
  const callbackUrl = new URL(location)
  const response = await dexApp.request(`/auth/callback${callbackUrl.search}`, {
    headers: { cookie: cookieHeaderOf(login) },
  })
  expect(await response.text()).toContain('"status":"signed_in"')
  expect((await sessionsOf(cookieHeaderOf(response), dexApp)).sessions.map((session) => session.workspaceId)).toEqual([
    acme,
    globex,
  ])
})
