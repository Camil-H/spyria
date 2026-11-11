import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { workspacePermissions } from '@spyria/kernel'
import { microsoftPersonalAccountsTenantId } from '@spyria/workspace/server'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createApp } from '../app.ts'
import { rateBudgets } from '../rate-limits.ts'
import {
  acme,
  alice,
  bob,
  captureLogs,
  globex,
  lee,
  rejectionOf,
  sessionTokenOf,
  testAuthSettings,
  testSetupToken,
  workspaceEventsOf,
} from '../testing/testing.ts'
import { createSecretBox } from './secret-box.ts'
import { openSessions } from './sessions.ts'
import { assertInstanceAppsConfigured } from './sso.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const emptyInstance = await createTestDatabase()
await emptyInstance.database.$client`truncate workspaces, users cascade`
const secretsKey = 'sso-integration-secrets-key-0123456789'
const nowInSeconds = () => Math.floor(Date.now() / 1000)
const commonPath = '/common/v2.0'

const startFakeIdp = async (issuerPath = '', { confirmsEmail = true } = {}) => {
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
type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>

const accountIdp = await startFakeIdp()
const microsoftIdp = await startFakeIdp('/tenant-1/v2.0', { confirmsEmail: false })
const hooliIdp = await startFakeIdp()
const starkIdp = await startFakeIdp()
const evilIdp = await startFakeIdp()
const firstWorkspaceIdp = await startFakeIdp()
accountIdp.clientSecrets['spyria-accounts'] = 'accounts-secret'
microsoftIdp.clientSecrets['spyria-microsoft'] = 'microsoft-secret'
firstWorkspaceIdp.clientSecrets['spyria-umbrella'] = 'umbrella-secret'
starkIdp.clientSecrets['spyria-stark'] = 'stark-secret'
const microsoftCommonIssuer = `${microsoftIdp.origin}${commonPath}`
const ssoSettings = {
  ...testAuthSettings,
  authMode: 'sso' as const,
  secretsKey,
  microsoftLoginOrigin: microsoftIdp.origin,
  instanceSignInApps: {
    microsoft: { clientId: 'spyria-microsoft', clientSecret: 'microsoft-secret' },
    oidc: { issuer: accountIdp.issuer, clientId: 'spyria-accounts', clientSecret: 'accounts-secret' },
  },
}
const app = createApp({ database, ...ssoSettings })
const emptyInstanceApp = createApp({ database: emptyInstance.database, ...ssoSettings })
afterAll(async () => {
  await emptyInstance.drop()
  for (const idp of [accountIdp, microsoftIdp, hooliIdp, starkIdp, evilIdp, firstWorkspaceIdp])
    await idp.server.stop(true)
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const addWorkspace = async (workspaceId: string, adminId: string = alice) => {
  await database.$client`
    insert into workspaces (workspace_id, name, created_by, created_at) values (${workspaceId}, ${workspaceId}, ${adminId}, now())`
  await database.$client`
    insert into workspace_roles (workspace_id, id, name, built_in)
    values (${workspaceId}, 'admin', 'Admin', true), (${workspaceId}, 'member', 'Member', true)`
  await database.$client`
    insert into workspace_role_permissions (workspace_id, role_id, permission)
    select ${workspaceId}, 'admin', unnest(${database.$client.array([...workspacePermissions])}::text[])`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${workspaceId}, ${adminId}, 'admin', 'Admin')`
}
const addMember = (workspaceId: string, userId: string) =>
  database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${workspaceId}, ${userId}, 'member', ${userId})`
const enforceSso = async (workspaceId: string, idp: FakeIdp, { preset = 'oidc', issuer = idp.issuer } = {}) => {
  const clientId = `spyria-${workspaceId}`
  idp.clientSecrets[clientId] = `${workspaceId}-secret`
  const encryptedClientSecret = await createSecretBox(secretsKey).seal(`${workspaceId}-secret`)
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${workspaceId}, ${preset}, ${issuer}, ${clientId}, ${encryptedClientSecret}, now())`
}
const invite = (workspaceId: string, email: string, { expiresIn = '7 days' } = {}) =>
  database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    select ${workspaceId}, ${crypto.randomUUID()}, ${email}, 'member', user_id, now(), now() + ${expiresIn}::interval
    from memberships where workspace_id = ${workspaceId} and role = 'admin' limit 1`
const isInvitationPending = async (workspaceId: string, email: string) =>
  (
    await database.$client`
      select 1 from invitations where workspace_id = ${workspaceId} and email = ${email} and accepted_at is null`
  ).length === 1

await addWorkspace('initech')
await enforceSso('initech', microsoftIdp, { preset: 'microsoft' })
await addWorkspace('hooli')
await enforceSso('hooli', hooliIdp)
await addWorkspace('stark')
await addMember('stark', bob)

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')
const sessionsOf = async (cookie: string, server = app) =>
  (await (await server.request('/auth/sessions', { headers: { cookie } })).json()) as {
    userId?: string
    sessions: { workspaceId: string; token: string }[]
  }
let codeCount = 0
const callbackAfter = async (idp: FakeIdp, started: Response, claims: JWTPayload, server = app) => {
  const location = new URL(started.headers.get('location') ?? '')
  expect(location.origin).toBe(idp.origin)
  const code = `code-${++codeCount}`
  idp.claimsByCode.set(code, { nonce: location.searchParams.get('nonce') ?? '', ...claims })
  const response = await server.request(`/auth/callback?code=${code}&state=${location.searchParams.get('state')}`, {
    headers: { cookie: cookieHeaderOf(started) },
  })
  const cookie = cookieHeaderOf(response)
  return {
    status: response.status,
    page: await response.text(),
    cookie,
    authorizationEndpoint: location.origin + location.pathname,
    clientId: location.searchParams.get('client_id'),
    loginHint: location.searchParams.get('login_hint'),
    ...(await sessionsOf(cookie, server)),
  }
}
const signInThrough = async (idp: FakeIdp, loginQuery: string, claims: JWTPayload, server = app) =>
  callbackAfter(idp, await server.request(`/auth/login?${loginQuery}`), claims, server)
const workspaceIdsOf = (signedIn: { sessions: { workspaceId: string }[] }) =>
  signedIn.sessions.map(({ workspaceId }) => workspaceId)
const identitiesOf = async (subject: string) => [
  ...(await database.$client`
    select workspace_id, issuer, user_id from identities where subject = ${subject} order by workspace_id`),
]
const accountIdentitiesOf = async (subject: string) => [
  ...(await database.$client`select issuer, user_id from account_identities where subject = ${subject}`),
]
const userIdsOf = async (email: string) =>
  (await database.$client<{ id: string }[]>`select id from users where email = ${email}`).map(({ id }) => id)
const bearerOf = async (workspaceId: string, userId: string) =>
  `Bearer ${await sessionTokenOf(database, workspaceId, userId)}`
const readSso = async (workspaceId: string, userId: string = alice) => {
  const response = await app.request('/api/sso-settings', {
    headers: { authorization: await bearerOf(workspaceId, userId) },
  })
  return { status: response.status, body: await response.text() }
}
const sameAppHeaders = { origin: testAuthSettings.appOrigin, 'x-spyria-csrf': '1', 'content-type': 'application/json' }
const renewStatus = async (workspaceId: string, cookie: string) =>
  (
    await app.request('/auth/renew', {
      method: 'POST',
      headers: { ...sameAppHeaders, cookie },
      body: JSON.stringify({ workspaceId }),
    })
  ).status
const openSessionWith = (token: string, workspaceId: string) =>
  app.request('/auth/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId }),
  })
const queryWith = (token: string) =>
  app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', []]),
  })
const sessionCookieOf = async (workspaceId: string, userId: string, through?: 'workspace sso') => {
  const [session] = await openSessions(database, userId, workspaceId, through)
  if (!session) throw new Error(`${userId} has no session in ${workspaceId}`)
  return `spyria_s_${workspaceId}=${session.sessionId}`
}
const createWorkspaceWith = (
  cookie: string,
  body: object,
  server = app,
  headers: Record<string, string> = sameAppHeaders,
) => server.request('/auth/workspaces', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(body) })
const startSsoChange = (
  workspaceId: string,
  cookie: string,
  form: Record<string, string>,
  origin = testAuthSettings.appOrigin,
) =>
  app.request('/auth/workspace-sso', {
    method: 'POST',
    headers: { origin, cookie },
    body: new URLSearchParams({ workspaceId, ...form }),
  })
const ssoEventsOf = async (workspaceId: string) =>
  (await workspaceEventsOf(database, workspaceId))
    .filter((event) => event.type.startsWith('sso.'))
    .map(({ type, actorId }) => [type, actorId])
const accountProviders = [
  { id: 'microsoft', kind: 'microsoft', isWorkspaceSso: false },
  { id: 'oidc', kind: 'oidc', isWorkspaceSso: false },
]

test('the server tells its auth mode, the account providers of this Spyria and whether a workspace can be created', async () => {
  const modeOf = async (server: { request: (path: string) => Response | Promise<Response> }, query = '') =>
    (await server.request(`/auth/mode${query}`)).json()
  const mode = { authMode: 'sso', accountProviders: ['microsoft', 'oidc'], instanceApps: ['microsoft'] }
  expect(await modeOf(app)).toEqual({ ...mode, isBeingSetUp: false, canCreateWorkspace: false })
  expect(await modeOf(emptyInstanceApp)).toEqual({ ...mode, isBeingSetUp: true, canCreateWorkspace: false })
  expect(await modeOf(emptyInstanceApp, `?setup=${testSetupToken}`)).toEqual({
    ...mode,
    isBeingSetUp: true,
    canCreateWorkspace: true,
  })
  const google = { clientId: 'spyria-google', clientSecret: 'google-secret' }
  expect(
    await modeOf(
      createApp({ database, ...ssoSettings, instanceSignInApps: { ...ssoSettings.instanceSignInApps, google } }),
    ),
  ).toMatchObject({ accountProviders: ['google', 'microsoft', 'oidc'], instanceApps: ['google', 'microsoft'] })
  expect(await modeOf(createApp({ database, ...ssoSettings, instanceSignInApps: {} }))).toMatchObject({
    accountProviders: [],
    instanceApps: [],
  })
  expect(await modeOf(createApp({ database: emptyInstance.database, ...testAuthSettings }))).toEqual({
    authMode: 'dex',
    isBeingSetUp: false,
    canCreateWorkspace: false,
    accountProviders: [],
    instanceApps: [],
  })
})

test('on an empty Spyria, signing in is refused until the first workspace is created from the setup link', async () => {
  const refused = await emptyInstanceApp.request('/auth/login?email=pat@example.com&provider=oidc')
  expect(refused.status).toBe(403)
  expect(refused.headers.get('location')).toBeNull()
  expect(await refused.text()).toContain(
    'This Spyria is being set up: open the setup link to create its first workspace',
  )
})

test('the providers of an address are the account providers, then the providers of the workspaces with their own SSO that invited it or count it as a member, without their names or ids', async () => {
  const providersOf = async (email: string, server = app) => {
    const response = await server.request(`/auth/providers?email=${encodeURIComponent(email)}`)
    return { status: response.status, body: await response.text() }
  }
  expect(JSON.parse((await providersOf('stranger@example.com')).body)).toEqual({ providers: accountProviders })
  const ofAlice = await providersOf('alice@example.com')
  expect(JSON.parse(ofAlice.body)).toEqual({
    providers: [
      ...accountProviders,
      { id: 'workspace-0', kind: 'microsoft', isWorkspaceSso: true },
      { id: 'workspace-1', kind: 'oidc', isWorkspaceSso: true },
    ],
  })
  for (const hidden of ['initech', 'hooli', microsoftIdp.origin, hooliIdp.origin])
    expect(ofAlice.body).not.toContain(hidden)
  await invite('hooli', 'pat@example.com')
  await invite('hooli', 'old@example.com', { expiresIn: '-1 second' })
  const ofPat = { providers: [...accountProviders, { id: 'workspace-0', kind: 'oidc', isWorkspaceSso: true }] }
  expect(JSON.parse((await providersOf('pat@example.com')).body)).toEqual(ofPat)
  expect(JSON.parse((await providersOf(' Pat@Example.com ')).body)).toEqual(ofPat)
  expect(JSON.parse((await providersOf('old@example.com')).body)).toEqual({ providers: accountProviders })
  expect(
    JSON.parse((await providersOf('alice@example.com', createApp({ database, ...testAuthSettings }))).body),
  ).toEqual({ providers: [] })
})

test('sign-in goes to the chosen provider with the address as a hint, and an unknown provider is refused before any redirect', async () => {
  const toHooli = await app.request('/auth/login?email=pat%40example.com&provider=workspace-0')
  const hooliLocation = new URL(toHooli.headers.get('location') ?? '')
  expect(hooliLocation.origin + hooliLocation.pathname).toBe(`${hooliIdp.issuer}/auth`)
  expect(hooliLocation.searchParams.get('client_id')).toBe('spyria-hooli')
  expect(hooliLocation.searchParams.get('login_hint')).toBe('pat@example.com')
  const toAccount = await app.request('/auth/login?email=pat%40example.com&provider=oidc')
  const accountLocation = new URL(toAccount.headers.get('location') ?? '')
  expect(accountLocation.origin + accountLocation.pathname).toBe(`${accountIdp.issuer}/auth`)
  expect(accountLocation.searchParams.get('client_id')).toBe('spyria-accounts')
  expect(accountLocation.searchParams.get('login_hint')).toBe('pat@example.com')
  expect(cookieHeaderOf(toAccount)).toContain('spyria_account_provider=oidc')
  const requestCounts = () => [accountIdp, microsoftIdp, hooliIdp].map((idp) => idp.requests.length)
  const countsBefore = requestCounts()
  for (const provider of ['workspace-1', 'workspace-x', 'google', ''])
    for (const email of ['pat@example.com', 'stranger@example.com']) {
      const refused = await app.request(`/auth/login?email=${email}&provider=${provider}`)
      expect(refused.status).toBe(404)
      expect(refused.headers.get('location')).toBeNull()
      expect(await refused.text()).toContain('"status":"failed"')
    }
  expect(requestCounts()).toEqual(countsBefore)
})

test('a login for one workspace goes to its own provider, or for a workspace without one to the last account provider used, else the first of this Spyria', async () => {
  const providerOf = async (loginQuery: string, cookie = '') => {
    const login = await app.request(`/auth/login?${loginQuery}`, { headers: { cookie } })
    const location = new URL(login.headers.get('location') ?? '')
    return location.origin + location.pathname
  }
  expect(await providerOf('workspace=hooli')).toBe(`${hooliIdp.issuer}/auth`)
  expect(await providerOf('workspace=hooli', 'spyria_account_provider=oidc')).toBe(`${hooliIdp.issuer}/auth`)
  expect(await providerOf(`workspace=${acme}`)).toBe(`${microsoftCommonIssuer}/auth`)
  expect(await providerOf(`workspace=${acme}`, 'spyria_account_provider=oidc')).toBe(`${accountIdp.issuer}/auth`)
})

test('an account signs in with a provider of this Spyria: the first sign-in binds it to the user of its confirmed address and opens only their workspaces without their own SSO', async () => {
  const signedIn = await signInThrough(accountIdp, 'email=alice@example.com&provider=oidc', {
    sub: 'alice-account',
    email: 'alice@example.com',
  })
  expect(signedIn.page).toContain('"status":"signed_in"')
  expect(signedIn.userId).toBe(alice)
  expect(workspaceIdsOf(signedIn)).toEqual([acme, globex, 'stark'])
  expect(Object.fromEntries(accountIdp.tokenRequests.at(-1) ?? [])).toMatchObject({
    client_id: 'spyria-accounts',
    client_secret: 'accounts-secret',
    code_verifier: expect.any(String),
  })
  expect(await accountIdentitiesOf('alice-account')).toEqual([{ issuer: accountIdp.issuer, user_id: alice }])
  expect(await identitiesOf('alice-account')).toEqual([])
})

test("a later sign-in with the same provider account finds the same user after its address changed, and another account of that provider carrying the user's address is refused", async () => {
  const renamed = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'alice-account',
    email: 'alice.new@example.com',
  })
  expect(renamed.page).toContain('"status":"signed_in"')
  expect(renamed.userId).toBe(alice)
  expect(await userIdsOf('alice.new@example.com')).toEqual([])
  const takeover = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'mallory-account',
    email: 'Alice@example.com',
  })
  expect(takeover.status).toBe(403)
  expect(takeover.page).toContain(
    '"status":"refused","message":"alice@example.com already signs in with another account of this provider"',
  )
  expect(takeover.sessions).toEqual([])
  expect(await accountIdentitiesOf('mallory-account')).toEqual([])
})

test('a new account joins the workspaces without their own SSO that invited exactly its address; the invites of a workspace with its own SSO and of other addresses stay pending', async () => {
  await invite(acme, 'nina@example.com')
  await invite('initech', 'nina@example.com')
  await invite(globex, 'nina.other@example.com')
  const signedIn = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'nina-account',
    email: 'Nina@Example.com',
    name: 'Nina Doe',
  })
  expect(signedIn.page).toContain('"status":"signed_in"')
  expect(workspaceIdsOf(signedIn)).toEqual([acme])
  expect(await userIdsOf('nina@example.com')).toEqual([String(signedIn.userId)])
  expect(await isInvitationPending(acme, 'nina@example.com')).toBe(false)
  expect(await isInvitationPending('initech', 'nina@example.com')).toBe(true)
  expect(await isInvitationPending(globex, 'nina.other@example.com')).toBe(true)
  expect([
    ...(await database.$client`select role, display_name from memberships where user_id = ${String(signedIn.userId)}`),
  ]).toEqual([{ role: 'member', display_name: 'Nina Doe' }])
})

test('an account in no workspace hears so and creates one as its Admin, from this app only', async () => {
  const signedIn = await signInThrough(accountIdp, 'provider=oidc', { sub: 'olive-account', email: 'olive@gmail.com' })
  expect(signedIn.status).toBe(200)
  expect(signedIn.page).toContain('"status":"no_workspace"')
  expect(signedIn.sessions).toEqual([])
  expect(signedIn.cookie).toContain('spyria_account=')
  const [oliveId = ''] = await userIdsOf('olive@gmail.com')
  const { 'x-spyria-csrf': _, ...withoutCsrf } = sameAppHeaders
  expect((await createWorkspaceWith(signedIn.cookie, { name: 'Olive Co' }, app, withoutCsrf)).status).toBe(403)
  expect(
    (
      await createWorkspaceWith(signedIn.cookie, { name: 'Olive Co' }, app, {
        ...sameAppHeaders,
        origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403)
  expect((await createWorkspaceWith('', { name: 'Olive Co' })).status).toBe(401)
  expect((await createWorkspaceWith(`${signedIn.cookie}x`, { name: 'Olive Co' })).status).toBe(401)
  const blank = await createWorkspaceWith(signedIn.cookie, { name: ' ' })
  expect(blank.status).toBe(400)
  expect(await blank.json()).toEqual({
    error: 'blank_name',
    message: 'A name must contain at least one non-blank character',
  })
  const onEmptyInstance = await createWorkspaceWith(signedIn.cookie, { name: 'Olive Co' }, emptyInstanceApp)
  expect(onEmptyInstance.status).toBe(400)
  expect(await onEmptyInstance.json()).toMatchObject({
    error: 'instance_being_set_up',
    message: 'This Spyria is being set up: open the setup link to create its first workspace',
  })
  expect(await emptyInstance.database.$client`select 1 from workspaces`).toHaveLength(0)

  const created = await createWorkspaceWith(signedIn.cookie, { name: ' Olive Co ' })
  expect(created.status).toBe(200)
  const issued = (await created.json()) as { workspaceId: string; token: string }
  expect(cookieHeaderOf(created)).toContain(`spyria_s_${issued.workspaceId}=`)
  expect([
    ...(await database.$client`
      select workspaces.name, created_by, user_id, role from workspaces join memberships using (workspace_id)
      where workspace_id = ${issued.workspaceId}`),
  ]).toEqual([{ name: 'Olive Co', created_by: oliveId, user_id: oliveId, role: 'admin' }])
  expect(JSON.parse((await readSso(issued.workspaceId, oliveId)).body)).toEqual({ settings: null })
  expect((await queryWith(issued.token)).status).toBe(200)
})

test('a generic OIDC provider that does not confirm the address is refused with the reason, and the invite stays pending', async () => {
  await invite(acme, 'erin@example.com')
  for (const unconfirmed of [{ email_verified: false }, { email_verified: undefined }]) {
    const refused = await signInThrough(accountIdp, 'provider=oidc', {
      sub: 'erin-account',
      email: 'erin@example.com',
      ...unconfirmed,
    })
    expect(refused.status).toBe(403)
    expect(refused.page).toContain('Your provider did not confirm this address')
    expect(refused.sessions).toEqual([])
  }
  expect(await isInvitationPending(acme, 'erin@example.com')).toBe(true)
  expect(await userIdsOf('erin@example.com')).toEqual([])
})

test('Microsoft personal and work accounts sign in through the common endpoint and are known by their tenant and object id', async () => {
  const workTenantId = '6f1e0c4d-1d2b-4c3a-9e8f-0a1b2c3d4e5f'
  const kimObjectId = '00000000-0000-4000-8000-00000000000a'
  const leeObjectId = '00000000-0000-4000-8000-00000000000b'
  await invite(acme, 'kim@outlook.com')
  const personal = await signInThrough(microsoftIdp, 'email=kim%40outlook.com&provider=microsoft', {
    tid: microsoftPersonalAccountsTenantId,
    oid: kimObjectId,
    sub: 'kim-per-app',
    preferred_username: 'kim@outlook.com',
  })
  expect(personal.authorizationEndpoint).toBe(`${microsoftCommonIssuer}/auth`)
  expect(personal.clientId).toBe('spyria-microsoft')
  expect(personal.page).toContain('"status":"signed_in"')
  expect(workspaceIdsOf(personal)).toEqual([acme])
  expect(await accountIdentitiesOf(kimObjectId)).toEqual([
    { issuer: `${microsoftIdp.origin}/${microsoftPersonalAccountsTenantId}/v2.0`, user_id: personal.userId },
  ])
  const work = await signInThrough(microsoftIdp, 'provider=microsoft', {
    tid: workTenantId,
    oid: leeObjectId,
    sub: 'lee-per-app',
    preferred_username: 'Lee@example.com',
  })
  expect(work.page).toContain('"status":"signed_in"')
  expect(work.userId).toBe(lee)
  expect(await accountIdentitiesOf(leeObjectId)).toEqual([
    { issuer: `${microsoftIdp.origin}/${workTenantId}/v2.0`, user_id: lee },
  ])

  for (const forged of [
    { tid: 'tenant-1' },
    { tid: workTenantId, iss: `${microsoftIdp.origin}/${microsoftPersonalAccountsTenantId}/v2.0` },
  ]) {
    const failed = await signInThrough(microsoftIdp, 'provider=microsoft', {
      sub: 'forged-per-app',
      oid: '00000000-0000-4000-8000-00000000000c',
      preferred_username: 'lee@example.com',
      ...forged,
    })
    expect(failed.status).toBe(400)
    expect(failed.page).toContain('"status":"failed"')
    expect(failed.sessions).toEqual([])
  }
  expect(await accountIdentitiesOf('00000000-0000-4000-8000-00000000000c')).toEqual([])
})

test('a Microsoft guest account from another tenant is never bound to a user by its address', async () => {
  const guest = await signInThrough(microsoftIdp, 'provider=microsoft', {
    tid: '6f1e0c4d-1d2b-4c3a-9e8f-0a1b2c3d4e5f',
    oid: '00000000-0000-4000-8000-00000000000d',
    sub: 'guest-per-app',
    preferred_username: 'bob@example.com',
    idp: 'https://sts.windows.net/another-tenant/',
  })
  expect(guest.status).toBe(403)
  expect(guest.page).toContain('"status":"not_invited","email":"bob@example.com"')
  expect(await accountIdentitiesOf('00000000-0000-4000-8000-00000000000d')).toEqual([])
})

test("a workspace's own provider opens only that workspace, and its session can neither open another workspace nor be widened by account sign-in", async () => {
  await database.$client`insert into users (id, email) values ('member-theo', 'theo@example.com')`
  await addMember(acme, 'member-theo')
  await addMember('hooli', 'member-theo')
  const throughHooli = await signInThrough(hooliIdp, 'email=theo%40example.com&provider=workspace-0', {
    sub: 'theo-hooli',
    email: 'theo@example.com',
  })
  expect(throughHooli.loginHint).toBe('theo@example.com')
  expect(throughHooli.page).toContain('"status":"signed_in"')
  expect(throughHooli.userId).toBe('member-theo')
  expect(workspaceIdsOf(throughHooli)).toEqual(['hooli'])
  expect(await identitiesOf('theo-hooli')).toEqual([
    { workspace_id: 'hooli', issuer: hooliIdp.issuer, user_id: 'member-theo' },
  ])
  const hooliToken = throughHooli.sessions[0]?.token ?? ''
  expect((await queryWith(hooliToken)).status).toBe(200)
  const widened = await openSessionWith(hooliToken, acme)
  expect(widened.status).toBe(403)
  expect(cookieHeaderOf(widened)).not.toContain('spyria_s_')

  const throughAccount = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'theo-account',
    email: 'theo@example.com',
  })
  expect(workspaceIdsOf(throughAccount)).toEqual([acme])
  expect((await openSessionWith(throughAccount.sessions[0]?.token ?? '', 'hooli')).status).toBe(403)
  const renamedAtHooli = await signInThrough(hooliIdp, 'workspace=hooli', {
    sub: 'theo-hooli',
    email: 'theo.new@example.com',
  })
  expect(renamedAtHooli.userId).toBe('member-theo')
  expect(workspaceIdsOf(renamedAtHooli)).toEqual(['hooli'])
  expect(await userIdsOf('theo.new@example.com')).toEqual([])
})

test('the invites of a workspace with its own SSO are accepted only through its provider, at the invited address', async () => {
  await invite('hooli', 'quinn@example.com')
  const throughAccount = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'quinn-account',
    email: 'quinn@example.com',
  })
  expect(throughAccount.page).toContain('"status":"no_workspace"')
  expect(await isInvitationPending('hooli', 'quinn@example.com')).toBe(true)
  const otherAddress = await signInThrough(hooliIdp, 'workspace=hooli', {
    sub: 'quinn-hooli',
    email: 'quinn.other@example.com',
  })
  expect(otherAddress.status).toBe(403)
  expect(otherAddress.page).toContain('"status":"not_invited","email":"quinn.other@example.com"')
  expect(await isInvitationPending('hooli', 'quinn@example.com')).toBe(true)
  const unconfirmed = await signInThrough(hooliIdp, 'workspace=hooli', {
    sub: 'quinn-hooli',
    email: 'quinn@example.com',
    email_verified: false,
  })
  expect(unconfirmed.status).toBe(403)
  expect(unconfirmed.page).toContain('Your provider did not confirm this address')
  expect(await isInvitationPending('hooli', 'quinn@example.com')).toBe(true)
  const joined = await signInThrough(hooliIdp, 'email=quinn%40example.com&provider=workspace-0', {
    sub: 'quinn-hooli',
    email: 'quinn@example.com',
  })
  expect(joined.page).toContain('"status":"signed_in"')
  expect(await userIdsOf('quinn@example.com')).toEqual([String(joined.userId)])
  expect(workspaceIdsOf(joined)).toEqual(['hooli'])
  expect(await isInvitationPending('hooli', 'quinn@example.com')).toBe(false)
})

test('a member bound to an identity of a workspace provider is never signed in through another identity carrying their address', async () => {
  const takeover = await signInThrough(hooliIdp, 'workspace=hooli', {
    sub: 'mallory-hooli',
    email: 'theo@example.com',
  })
  expect(takeover.status).toBe(403)
  expect(takeover.page).toContain('"status":"not_invited","email":"theo@example.com"')
  expect(takeover.sessions).toEqual([])
  expect(await identitiesOf('mallory-hooli')).toEqual([])
})

test("a workspace provider asserting someone else's address gets at most a session in its own workspace", async () => {
  await database.$client`insert into users (id, email) values ('member-mallory', 'mallory@evil.test')`
  await addWorkspace('evil', 'member-mallory')
  await enforceSso('evil', evilIdp)
  const uninvited = await signInThrough(evilIdp, 'workspace=evil', { sub: 'forged-bob', email: 'bob@example.com' })
  expect(uninvited.status).toBe(403)
  expect(uninvited.page).toContain('"status":"not_invited","email":"bob@example.com"')
  await invite('evil', 'alice@example.com')
  const forged = await signInThrough(evilIdp, 'workspace=evil', { sub: 'forged-alice', email: 'alice@example.com' })
  expect(forged.userId).toBe(alice)
  expect(workspaceIdsOf(forged)).toEqual(['evil'])
  for (const workspaceId of [acme, globex, 'stark'])
    expect((await openSessionWith(forged.sessions[0]?.token ?? '', workspaceId)).status).toBe(403)
  expect(await accountIdentitiesOf('forged-alice')).toEqual([])
  expect(await accountIdentitiesOf('alice-account')).toEqual([{ issuer: accountIdp.issuer, user_id: alice }])
})

test('an Entra token without email_verified signs in by preferred_username through the tenant issuer of its workspace', async () => {
  await invite('initech', 'peter@initech.com')
  const signedIn = await signInThrough(microsoftIdp, 'workspace=initech', {
    sub: 'peter-subject',
    oid: 'peter-object',
    preferred_username: 'Peter@initech.com',
  })
  expect(signedIn.authorizationEndpoint).toBe(`${microsoftIdp.issuer}/auth`)
  expect(signedIn.clientId).toBe('spyria-initech')
  expect(signedIn.page).toContain('"status":"signed_in"')
  expect(workspaceIdsOf(signedIn)).toEqual(['initech'])
})

test('a Microsoft member bound under the per-app subject of another app signs in by user principal name and gains their object id', async () => {
  await database.$client`insert into users (id, email) values ('member-sam', 'sam@initech.com')`
  await addMember('initech', 'member-sam')
  await database.$client`
    insert into identities (workspace_id, issuer, subject, user_id)
    values ('initech', ${microsoftIdp.issuer}, 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ', 'member-sam')`
  const objectId = '00000000-0000-4000-8000-0000000000aa'
  const signedIn = await signInThrough(microsoftIdp, 'workspace=initech', {
    sub: 'per-app-subject-of-the-other-app',
    oid: objectId,
    preferred_username: 'sam@initech.com',
  })
  expect(signedIn.page).toContain('"status":"signed_in"')
  expect(signedIn.userId).toBe('member-sam')
  expect(await identitiesOf(objectId)).toEqual([
    { workspace_id: 'initech', issuer: microsoftIdp.issuer, user_id: 'member-sam' },
  ])
  const takeover = await signInThrough(microsoftIdp, 'workspace=initech', {
    sub: 'mallory-per-app',
    oid: '00000000-0000-4000-8000-0000000000bb',
    preferred_username: 'sam@initech.com',
  })
  expect(takeover.page).toContain('"status":"not_invited","email":"sam@initech.com"')
})

test('an Entra guest from another tenant is never bound to a member or an invite of a workspace by email', async () => {
  await invite('initech', 'gina@initech.com')
  const guest = await signInThrough(microsoftIdp, 'workspace=initech', {
    sub: 'gina-per-app',
    oid: '00000000-0000-4000-8000-0000000000cc',
    preferred_username: 'gina@initech.com',
    idp: 'https://sts.windows.net/another-tenant/',
  })
  expect(guest.status).toBe(403)
  expect(guest.page).toContain('"status":"not_invited","email":"gina@initech.com"')
  expect(await identitiesOf('00000000-0000-4000-8000-0000000000cc')).toEqual([])
})

const starkForm = { preset: 'oidc', issuer: starkIdp.issuer, clientId: 'spyria-stark', clientSecret: 'stark-secret' }

test('Setup SSO is only for members who may set it up, and refuses another origin, no session, a failing discovery, a multi-tenant Entra issuer and a first save without secret, changing nothing', async () => {
  const refusedToBob = await startSsoChange('stark', await sessionCookieOf('stark', bob), starkForm)
  expect(refusedToBob.status).toBe(400)
  expect(refusedToBob.headers.get('location')).toBeNull()
  expect(await refusedToBob.text()).toContain(
    '"status":"refused","message":"Your workspace role does not allow this: Set up SSO"',
  )
  expect((await readSso('stark', bob)).status).toBe(403)
  const aliceCookie = await sessionCookieOf('stark', alice)
  expect((await startSsoChange('stark', aliceCookie, starkForm, 'https://elsewhere.example')).status).toBe(403)
  expect((await startSsoChange('stark', '', starkForm)).status).toBe(401)
  for (const [change, reason] of [
    [{ issuer: 'http://127.0.0.1:9/nothing' }, 'The discovery of http://127.0.0.1:9/nothing failed: '],
    [{ preset: 'microsoft', tenantId: 'common' }, 'Only a tenant-specific Microsoft Entra issuer is accepted'],
    [{ clientSecret: '' }, 'A client secret is required'],
  ] as const) {
    const refused = await startSsoChange('stark', aliceCookie, { ...starkForm, ...change })
    expect(refused.status).toBe(400)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.text()).toContain(`"status":"refused","message":"${reason}`)
  }
  expect(await database.$client`select 1 from workspace_sso where workspace_id = 'stark'`).toHaveLength(0)
  expect(JSON.parse((await readSso('stark')).body)).toEqual({ settings: null })
})

test("confirming Setup SSO needs the admin's own address at the new provider: another address changes nothing", async () => {
  const aliceCookie = await sessionCookieOf('stark', alice)
  const mismatch = await callbackAfter(starkIdp, await startSsoChange('stark', aliceCookie, starkForm), {
    sub: 'it-stark',
    email: 'it@stark.test',
  })
  expect(mismatch.authorizationEndpoint).toBe(`${starkIdp.issuer}/auth`)
  expect(mismatch.loginHint).toBe('alice@example.com')
  expect(mismatch.status).toBe(403)
  expect(mismatch.page).toContain('Sign in as alice@example.com to confirm the provider: nothing was changed')
  expect(mismatch.sessions).toEqual([])
  expect(await database.$client`select 1 from workspace_sso where workspace_id = 'stark'`).toHaveLength(0)
  expect(await identitiesOf('it-stark')).toEqual([])
  expect(await ssoEventsOf('stark')).toEqual([])
  expect(await renewStatus('stark', aliceCookie)).toBe(200)
})

test('once its admin confirms Setup SSO, the workspace signs in only through its provider: its account sessions stop and the admin has a session through it', async () => {
  const aliceCookie = await sessionCookieOf('stark', alice)
  const bobToken = await sessionTokenOf(database, 'stark', bob)
  const confirmed = await callbackAfter(starkIdp, await startSsoChange('stark', aliceCookie, starkForm), {
    sub: 'alice-stark',
    email: 'Alice@example.com',
  })
  expect(confirmed.page).toContain('"status":"signed_in"')
  expect(confirmed.userId).toBe(alice)
  expect(workspaceIdsOf(confirmed)).toEqual(['stark'])
  expect(Object.fromEntries(starkIdp.tokenRequests.at(-1) ?? [])).toMatchObject({
    client_id: 'spyria-stark',
    client_secret: 'stark-secret',
  })
  expect(await identitiesOf('alice-stark')).toEqual([
    { workspace_id: 'stark', issuer: starkIdp.issuer, user_id: alice },
  ])
  expect(await renewStatus('stark', aliceCookie)).toBe(401)
  expect((await queryWith(bobToken)).status).toBe(401)
  expect((await openSessionWith(confirmed.sessions[0]?.token ?? '', acme)).status).toBe(403)

  const [stored] = await database.$client<{ encryptedClientSecret: string }[]>`
    select encrypted_client_secret as "encryptedClientSecret" from workspace_sso where workspace_id = 'stark'`
  expect(stored?.encryptedClientSecret).not.toContain('stark-secret')
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('stark-secret')
  const read = await readSso('stark')
  expect(JSON.parse(read.body)).toEqual({
    settings: {
      preset: 'oidc',
      issuer: starkIdp.issuer,
      clientId: 'spyria-stark',
      tenantId: '',
      hasSecret: true,
      usesInstanceApp: false,
    },
  })
  expect(read.body).not.toContain('stark-secret')
  expect(read.body).not.toContain(stored?.encryptedClientSecret ?? '')
  expect(await ssoEventsOf('stark')).toEqual([['sso.configured', alice]])
  expect(
    (await database.$client`select tablename from pg_publication_tables where pubname = 'spyria_zero'`).map(
      ({ tablename }) => tablename,
    ),
  ).not.toContain('workspace_sso')
})

test('rotating only the client secret keeps the sessions of the workspace and is recorded; a save without a secret keeps the stored one', async () => {
  const aliceCookie = await sessionCookieOf('stark', alice, 'workspace sso')
  starkIdp.clientSecrets['spyria-stark'] = 'stark-secret-2'
  const rotated = await callbackAfter(
    starkIdp,
    await startSsoChange('stark', aliceCookie, { ...starkForm, clientSecret: 'stark-secret-2' }),
    { sub: 'alice-stark', email: 'alice@example.com' },
  )
  expect(rotated.page).toContain('"status":"signed_in"')
  expect(await renewStatus('stark', aliceCookie)).toBe(200)
  const [stored] = await database.$client<{ encryptedClientSecret: string }[]>`
    select encrypted_client_secret as "encryptedClientSecret" from workspace_sso where workspace_id = 'stark'`
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('stark-secret-2')
  expect(await ssoEventsOf('stark')).toEqual([
    ['sso.configured', alice],
    ['sso.secret_rotated', alice],
  ])
  const keptSecret = await startSsoChange('stark', aliceCookie, { ...starkForm, clientSecret: '' })
  expect(keptSecret.status).toBe(302)
  expect(new URL(keptSecret.headers.get('location') ?? '').origin).toBe(starkIdp.origin)
})

test('stopping SSO takes the workspace back to account sign-in and ends every session in it; it is refused to members who may not set it up and without account sign-in on this Spyria', async () => {
  const stop = async (server: typeof app, userId: string) =>
    server.request('/api/sso-settings/stop', {
      method: 'POST',
      headers: { authorization: await bearerOf('stark', userId) },
    })
  const aliceCookie = await sessionCookieOf('stark', alice, 'workspace sso')
  expect((await stop(app, bob)).status).toBe(403)
  const refused = await stop(createApp({ database, ...ssoSettings, instanceSignInApps: {} }), alice)
  expect(refused.status).toBe(400)
  expect(await refused.json()).toEqual({
    error: 'no_account_sign_in',
    message:
      'This Spyria has no sign-in of its own for members to use instead: an operator sets up Google, Microsoft or OIDC',
  })
  expect(await database.$client`select 1 from workspace_sso where workspace_id = 'stark'`).toHaveLength(1)
  expect((await stop(createApp({ database, ...testAuthSettings, secretsKey }), alice)).status).toBe(204)
  expect(await database.$client`select 1 from workspace_sso where workspace_id = 'stark'`).toHaveLength(0)
  expect(await database.$client`select 1 from sessions where workspace_id = 'stark'`).toHaveLength(0)
  expect(await renewStatus('stark', aliceCookie)).toBe(401)
  expect((await ssoEventsOf('stark')).at(-1)).toEqual(['sso.removed', alice])
  const back = await signInThrough(accountIdp, 'provider=oidc', { sub: 'alice-account', email: 'alice@example.com' })
  expect(workspaceIdsOf(back)).toContain('stark')
})

test('the test sign-in hook works in sso mode', async () => {
  const testApp = createApp({ database, ...ssoSettings, testDatabaseByName: () => database })
  const testCookie = `spyria_test=${encodeURIComponent(JSON.stringify({ db: testDatabase.name, user: bob }))}`
  const login = await testApp.request('/auth/login', { headers: { cookie: testCookie } })
  expect(await login.text()).toContain('"status":"signed_in"')
  expect(cookieHeaderOf(login)).toContain(`spyria_s_${acme}=`)
})

const umbrellaForm = () => ({
  name: ' Umbrella ',
  preset: 'oidc',
  issuer: firstWorkspaceIdp.issuer,
  clientId: 'spyria-umbrella',
  clientSecret: 'umbrella-secret',
})
const startCreation = (form: Record<string, string>, origin = testAuthSettings.appOrigin, server = emptyInstanceApp) =>
  server.request('/auth/first-workspace', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams({ setupToken: testSetupToken, ...form }),
  })
const countsOf = async () =>
  (
    await emptyInstance.database.$client`
      select (select count(*) from workspaces)::int as workspaces, (select count(*) from users)::int as users`
  )[0]

test('sign-in routing, the sign-in callback, workspace creation, SSO changes and setup link checks answer 429 with Retry-After past their budget per address; the sign-in mode without a setup link stays open', async () => {
  const limitedApp = createApp({ database: emptyInstance.database, ...ssoSettings, rateLimits: rateBudgets })
  const elsewhere = { method: 'POST', headers: { origin: 'https://elsewhere.example' } }
  const requests = {
    emailRouting: () => limitedApp.request('/auth/login?email=pat@other.com'),
    signInCallback: () => limitedApp.request('/auth/callback?code=forged&state=forged'),
    workspaceCreation: () => limitedApp.request('/auth/first-workspace', elsewhere),
    ssoChanges: () => limitedApp.request('/auth/workspace-sso', elsewhere),
    setupToken: () => limitedApp.request('/auth/mode?setup=guessed'),
  }
  const logs = captureLogs()
  try {
    for (const [name, request] of Object.entries(requests) as [keyof typeof requests, () => Promise<Response>][]) {
      for (let sent = 0; sent < rateBudgets[name].count; sent++) expect((await request()).status).not.toBe(429)
      const refused = await request()
      expect({ name, status: refused.status }).toEqual({ name, status: 429 })
      const retryAfter = Number(refused.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(
        Math.ceil(rateBudgets[name].perMilliseconds / rateBudgets[name].count / 1000),
      )
      expect(await refused.text()).toBe(`Too many requests: try again in ${retryAfter} seconds.`)
    }
    expect((await limitedApp.request('/auth/mode')).status).toBe(200)
  } finally {
    logs.restore()
  }
  expect(await countsOf()).toEqual({ workspaces: 0, users: 0 })
  expect(logs.events.filter((logged) => logged.event === 'rate_limit.hit').map((logged) => logged.attributes)).toEqual(
    Object.keys(requests).map((name) => ({ 'rate_limit.name': name })),
  )
})

test('on an empty Spyria, creating the first workspace refuses another origin, invalid settings and a failing discovery, creating nothing', async () => {
  expect((await startCreation(umbrellaForm(), 'https://elsewhere.example')).status).toBe(403)
  for (const [change, reason] of [
    [{ name: ' ' }, 'A name must contain at least one non-blank character'],
    [{ clientSecret: '' }, 'A client secret is required'],
    [{ preset: 'microsoft', tenantId: 'common' }, 'Only a tenant-specific Microsoft Entra issuer is accepted'],
    [{ issuer: 'http://127.0.0.1:9/nothing' }, 'The discovery of http://127.0.0.1:9/nothing failed: '],
  ] as const) {
    const refused = await startCreation({ ...umbrellaForm(), ...change })
    expect(refused.status).toBe(400)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.text()).toContain(`"status":"refused","message":"${reason}`)
  }
  expect(await countsOf()).toEqual({ workspaces: 0, users: 0 })
})

test('the first person completing sign-in becomes the Admin of a workspace with its own provider: of two at once exactly one wins, then creation is closed; its provider signs its Admin back in and admits nobody uninvited', async () => {
  const [carolStart, daveStart] = [await startCreation(umbrellaForm()), await startCreation(umbrellaForm())]
  expect(cookieHeaderOf(carolStart)).not.toContain('umbrella-secret')
  const [carol, dave] = await Promise.all([
    callbackAfter(
      firstWorkspaceIdp,
      carolStart,
      { sub: 'carol-subject', email: 'Carol@umbrella.com' },
      emptyInstanceApp,
    ),
    callbackAfter(firstWorkspaceIdp, daveStart, { sub: 'dave-subject', email: 'dave@umbrella.com' }, emptyInstanceApp),
  ])
  const [winner, loser] = carol.status === 200 ? [carol, dave] : [dave, carol]
  expect(winner.page).toContain('"status":"signed_in"')
  expect(loser.status).toBe(403)
  expect(loser.page).toContain('This Spyria already has a workspace: sign in, then create yours')
  expect(await countsOf()).toEqual({ workspaces: 1, users: 1 })
  const [member] = await emptyInstance.database.$client<
    { workspaceId: string; userId: string; email: string; role: string; name: string }[]
  >`
    select workspace_id as "workspaceId", user_id as "userId", users.email, role, workspaces.name
    from memberships join users on users.id = memberships.user_id join workspaces using (workspace_id)`
  const { workspaceId, userId } = member ?? { workspaceId: '', userId: '' }
  expect(member).toMatchObject({
    name: 'Umbrella',
    role: 'admin',
    email: winner === carol ? 'carol@umbrella.com' : 'dave@umbrella.com',
  })
  expect(winner).toMatchObject({ userId, sessions: [{ workspaceId }] })
  expect(
    (await workspaceEventsOf(emptyInstance.database, workspaceId)).map(({ type, actorId }) => [type, actorId]),
  ).toEqual([
    ['member.joined', userId],
    ['sso.configured', userId],
  ])
  const [stored] = await emptyInstance.database.$client`
    select issuer, client_id as "clientId", encrypted_client_secret as "encryptedClientSecret" from workspace_sso`
  expect(stored).toMatchObject({ issuer: firstWorkspaceIdp.issuer, clientId: 'spyria-umbrella' })
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('umbrella-secret')
  const winnerSubject = winner === carol ? 'carol-subject' : 'dave-subject'
  expect([...(await emptyInstance.database.$client`select subject, user_id as "userId" from identities`)]).toEqual([
    { subject: winnerSubject, userId },
  ])
  expect(await emptyInstance.database.$client`select 1 from account_identities`).toHaveLength(0)

  expect(await (await emptyInstanceApp.request('/auth/mode')).json()).toMatchObject({
    isBeingSetUp: false,
    canCreateWorkspace: false,
  })
  expect(await (await startCreation(umbrellaForm())).text()).toContain(
    '"status":"refused","message":"This Spyria already has a workspace: sign in, then create yours"',
  )
  const adminBack = await signInThrough(
    firstWorkspaceIdp,
    `workspace=${workspaceId}`,
    { sub: winnerSubject, email: member?.email },
    emptyInstanceApp,
  )
  expect(adminBack.page).toContain('"status":"signed_in"')
  expect(adminBack).toMatchObject({ userId, sessions: [{ workspaceId }] })
  const erin = await signInThrough(
    firstWorkspaceIdp,
    `workspace=${workspaceId}`,
    { sub: 'erin-subject', email: 'erin@umbrella.com' },
    emptyInstanceApp,
  )
  expect(erin.status).toBe(403)
  expect(erin.page).toContain('"status":"not_invited","email":"erin@umbrella.com"')
  expect(await countsOf()).toEqual({ workspaces: 1, users: 1 })
})

test('the first workspace created with an account provider has no SSO of its own: its Admin signs in with that account', async () => {
  await emptyInstance.database.$client`truncate workspaces, users cascade`
  const started = await startCreation({ name: 'Garage', accountProvider: 'oidc' })
  const created = await callbackAfter(
    accountIdp,
    started,
    { sub: 'owner-account', email: 'owner@gmail.com' },
    emptyInstanceApp,
  )
  expect(created.clientId).toBe('spyria-accounts')
  expect(created.page).toContain('"status":"signed_in"')
  const [workspace] = await emptyInstance.database.$client<{ workspaceId: string; name: string }[]>`
    select workspace_id as "workspaceId", name from workspaces`
  expect(workspace?.name).toBe('Garage')
  expect(created).toMatchObject({ sessions: [{ workspaceId: workspace?.workspaceId }] })
  expect(await emptyInstance.database.$client`select 1 from workspace_sso`).toHaveLength(0)
  expect(await emptyInstance.database.$client`select 1 from identities`).toHaveLength(0)
  expect([
    ...(await emptyInstance.database.$client`
      select issuer, subject, users.email, role from account_identities join users on users.id = account_identities.user_id
      join memberships using (user_id)`),
  ]).toEqual([{ issuer: accountIdp.issuer, subject: 'owner-account', email: 'owner@gmail.com', role: 'admin' }])
  expect((await workspaceEventsOf(emptyInstance.database, workspace?.workspaceId)).map(({ type }) => type)).toEqual([
    'member.joined',
  ])
  const back = await signInThrough(
    accountIdp,
    'email=owner%40gmail.com&provider=oidc',
    { sub: 'owner-account', email: 'owner@gmail.com' },
    emptyInstanceApp,
  )
  expect(back).toMatchObject({ userId: created.userId, sessions: [{ workspaceId: workspace?.workspaceId }] })
})

test('the first workspace needs the setup token: refused without it, with a wrong one, and once a workspace exists; the sign-in mode only offers creation with it', async () => {
  await emptyInstance.database.$client`truncate workspaces, users cascade`
  const modeOf = async (query = '') => (await emptyInstanceApp.request(`/auth/mode${query}`)).json()
  expect(await modeOf()).toMatchObject({ isBeingSetUp: true, canCreateWorkspace: false })
  expect(await modeOf('?setup=not-the-token')).toMatchObject({ isBeingSetUp: true, canCreateWorkspace: false })
  expect(await modeOf(`?setup=${testSetupToken}`)).toMatchObject({ isBeingSetUp: true, canCreateWorkspace: true })
  for (const refusedToken of ['', 'not-the-token', `${testSetupToken} `]) {
    const refused = await startCreation({ ...umbrellaForm(), setupToken: refusedToken })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('This Spyria is being set up: open the setup link')
    expect(await emptyInstance.database.$client`select 1 from workspaces`).toHaveLength(0)
  }
  const started = await startCreation(umbrellaForm())
  expect(started.status).toBe(302)
  await callbackAfter(firstWorkspaceIdp, started, { sub: 'u-setup', email: 'owner@umbrella.com' }, emptyInstanceApp)
  expect(await emptyInstance.database.$client`select 1 from workspaces`).toHaveLength(1)
  expect(await modeOf(`?setup=${testSetupToken}`)).toMatchObject({ isBeingSetUp: false, canCreateWorkspace: false })
  const spent = await startCreation(umbrellaForm())
  expect(spent.status).toBe(400)
  expect(await spent.text()).toContain('This Spyria already has a workspace: sign in, then create yours')
})

test('with the Microsoft app of this Spyria, a workspace is created and signed in to without any client id or secret, and an app the Spyria lacks is refused', async () => {
  const instance = await createTestDatabase()
  await instance.database.$client`truncate workspaces, users cascade`
  const instanceApp = createApp({ database: instance.database, ...ssoSettings })
  try {
    const create = (form: Record<string, string>) =>
      startCreation({ name: 'Initech', usesInstanceApp: 'true', ...form }, testAuthSettings.appOrigin, instanceApp)
    expect(await (await create({ preset: 'google' })).text()).toContain(
      'This Spyria has no Google app: enter the client id and secret of your own',
    )
    const completed = await callbackAfter(
      microsoftIdp,
      await create({ preset: 'microsoft', tenantId: 'tenant-1' }),
      { sub: 'pat', oid: 'pat-object', preferred_username: 'pat@initech.com' },
      instanceApp,
    )
    expect(completed.authorizationEndpoint).toBe(`${microsoftIdp.issuer}/auth`)
    expect(completed.clientId).toBe('spyria-microsoft')
    expect(completed.page).toContain('"status":"signed_in"')
    expect(microsoftIdp.tokenRequests.at(-1)?.get('client_id')).toBe('spyria-microsoft')
    const [stored] = await instance.database.$client`
      select workspace_id as "workspaceId", preset, issuer, client_id as "clientId",
        encrypted_client_secret as "encryptedClientSecret", uses_instance_app as "usesInstanceApp"
      from workspace_sso`
    expect(stored).toMatchObject({
      preset: 'microsoft',
      issuer: microsoftIdp.issuer,
      clientId: 'spyria-microsoft',
      encryptedClientSecret: '',
      usesInstanceApp: true,
    })
    const signedIn = await signInThrough(
      microsoftIdp,
      `workspace=${stored?.workspaceId}`,
      { sub: 'pat-in-another-app', oid: 'pat-object', preferred_username: 'pat@initech.com' },
      instanceApp,
    )
    expect(signedIn.sessions).toHaveLength(1)
    expect(signedIn.userId).toBe(completed.userId)
  } finally {
    await instance.drop()
  }
})

test('the server refuses to start when workspaces sign in through an app of this deployment that is no longer configured', async () => {
  await addWorkspace('wayne')
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, updated_at)
    values ('wayne', 'google', 'https://accounts.google.com', 'spyria-google', '', true, now())`
  const google = { clientId: 'spyria-google', clientSecret: 'secret' }
  expect(await assertInstanceAppsConfigured(database, { google })).toBeUndefined()
  expect((await rejectionOf(assertInstanceAppsConfigured(database, {}))).message).toBe(
    'Workspaces sign in through apps of this deployment that are not configured: google (1 workspace). Set SPYRIA_GOOGLE_CLIENT_* or SPYRIA_MICROSOFT_CLIENT_* again.',
  )
})

test('a workspace awaiting its purge does not hold up the start for an app it used', async () => {
  await database.$client`update workspaces set deleted_at = now(), purge_at = now() + interval '7 days' where workspace_id = 'wayne'`
  expect(await assertInstanceAppsConfigured(database, {})).toBeUndefined()
})
