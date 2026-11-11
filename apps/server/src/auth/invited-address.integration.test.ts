import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createApp } from '../app.ts'
import { rejectionOf, testAuthSettings, testSetupToken } from '../testing/testing.ts'
import { createSecretBox, secretsKeyringOf } from './secret-box.ts'
import { issueSessionToken } from './session-tokens.ts'
import { openSessions } from './sessions.ts'
import { applyConfiguredSignInApp, replaceSignInApp } from './sso.ts'

const instance = await createTestDatabase()
const { database } = instance
await database.$client`truncate workspaces, users cascade`
const nowInSeconds = () => Math.floor(Date.now() / 1000)
const clientSecret = 'invited-secret'

const keys = await generateKeyPair('RS256')
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'invited-idp', alg: 'RS256', use: 'sig' }
const claimsByCode = new Map<string, JWTPayload>()
const idp = Bun.serve({
  port: 0,
  fetch: async (request) => {
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
    if (pathname === '/keys') return Response.json({ keys: [publicKey] })
    if (pathname !== '/token') return new Response(null, { status: 404 })
    const form = new URLSearchParams(await request.text())
    if (form.get('client_secret') !== clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 })
    const idToken = await new SignJWT({
      iss: origin,
      aud: form.get('client_id') ?? '',
      iat: nowInSeconds(),
      exp: nowInSeconds() + 60,
      ...claimsByCode.get(form.get('code') ?? ''),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'invited-idp' })
      .sign(keys.privateKey)
    return Response.json({ access_token: 'access', token_type: 'Bearer', id_token: idToken })
  },
})
const issuer = idp.url.origin
const secretsKeyring = secretsKeyringOf('invited-integration-secrets-key-0123456789')
const app = createApp({
  database,
  ...testAuthSettings,
  authMode: 'sso',
  secretsKeyring,
  joinBy: 'invited_address',
})
afterAll(async () => {
  await idp.stop(true)
  await instance.drop()
}, databaseDropTimeoutMilliseconds)

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')
let nextCode = 1
const callbackAfter = async (started: Response, claims: JWTPayload) => {
  const location = new URL(started.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(`${issuer}/auth`)
  const code = `code-${nextCode++}`
  claimsByCode.set(code, { nonce: location.searchParams.get('nonce') ?? '', ...claims })
  const response = await app.request(`/auth/callback?code=${code}&state=${location.searchParams.get('state')}`, {
    headers: { cookie: cookieHeaderOf(started) },
  })
  const sessions = await (await app.request('/auth/sessions', { headers: { cookie: cookieHeaderOf(response) } })).json()
  return {
    status: response.status,
    page: await response.text(),
    sessions: sessions.sessions as { workspaceId: string }[],
  }
}
const creationForm = {
  setupToken: testSetupToken,
  name: 'Garage',
  preset: 'oidc',
  issuer,
  clientId: 'spyria',
  clientSecret,
}
const startCreation = (form: Record<string, string>) =>
  app.request('/auth/first-workspace', {
    method: 'POST',
    headers: { origin: testAuthSettings.appOrigin },
    body: new URLSearchParams(form),
  })
const signIn = async (email: string, claims: JWTPayload) => {
  const login = await app.request(`/auth/login?email=${encodeURIComponent(email)}`)
  if (login.status !== 302) return { status: login.status, page: await login.text(), sessions: [] }
  return callbackAfter(login, claims)
}
const inviteTo = (workspaceId: string, email: string) =>
  database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    select ${workspaceId}, ${crypto.randomUUID()}, ${email}, 'member', user_id, now(), now() + interval '7 days'
    from memberships where workspace_id = ${workspaceId} and role = 'admin' limit 1`
const pendingInvitesOf = async (email: string) =>
  (await database.$client`select 1 from invitations where email = ${email} and accepted_at is null`).length
let workspaceId = ''

test('the first person creates a workspace joined by invited address with a consumer address: no domain, Admin at once', async () => {
  expect(await (await app.request(`/auth/mode?setup=${testSetupToken}`)).json()).toMatchObject({
    joinBy: 'invited_address',
    canCreateWorkspace: true,
  })
  const withDomain = await startCreation({ ...creationForm, domain: 'garage.com' })
  expect(withDomain.status).toBe(400)
  expect(await withDomain.text()).toContain('A workspace joined by invited address owns no email domain')

  const created = await callbackAfter(await startCreation(creationForm), {
    sub: 'owner-subject',
    email: 'owner@gmail.com',
    email_verified: true,
  })
  expect(created.status).toBe(200)
  const [workspace] = await database.$client`select workspace_id, join_by from workspaces`
  workspaceId = String(workspace?.workspace_id)
  expect(workspace?.join_by).toBe('invited_address')
  expect(created.sessions.map((session) => session.workspaceId)).toEqual([workspaceId])
  expect(await database.$client`select 1 from sso_domains`).toHaveLength(0)
  expect([
    ...(await database.$client`
        select role from memberships join users on users.id = memberships.user_id where users.email = 'owner@gmail.com'`),
  ]).toEqual([{ role: 'admin' }])
  expect((await database.$client`select 1 from workspace_sso where workspace_id = ${workspaceId}`).length).toBe(1)
})

test('an invitee signs in at exactly the invited address and joins with the invited role; later sign-ins match the provider identity, not the address', async () => {
  await inviteTo(workspaceId, 'bob@gmail.com')
  const joined = await signIn('Bob@Gmail.com', { sub: 'bob-subject', email: 'bob@gmail.com', email_verified: true })
  expect(joined.sessions.map((session) => session.workspaceId)).toEqual([workspaceId])
  expect(await pendingInvitesOf('bob@gmail.com')).toBe(0)
  expect([
    ...(await database.$client`
        select role from memberships join users on users.id = memberships.user_id where users.email = 'bob@gmail.com'`),
  ]).toEqual([{ role: 'member' }])
  expect(
    await database.$client`select 1 from identities where subject = 'bob-subject' and issuer = ${issuer}`,
  ).toHaveLength(1)

  const again = await signIn('bob@gmail.com', { sub: 'bob-subject', email: 'bob@gmail.com', email_verified: true })
  expect(again.sessions.map((session) => session.workspaceId)).toEqual([workspaceId])
})

test('a verified address nobody invited is refused once the provider has signed it in, and nothing routes by its domain', async () => {
  const refused = await signIn('carol@gmail.com', {
    sub: 'carol-subject',
    email: 'carol@gmail.com',
    email_verified: true,
  })
  expect(refused.status).toBe(403)
  expect(refused.page).toContain('"status":"not_invited"')
  expect(refused.page).toContain('carol@gmail.com')
  expect(refused.sessions).toEqual([])
})

test('an invitee whose provider returns another verified address is refused and the invite stays pending', async () => {
  await inviteTo(workspaceId, 'dave@gmail.com')
  const refused = await signIn('dave@gmail.com', {
    sub: 'dave-subject',
    email: 'dave.other@gmail.com',
    email_verified: true,
  })
  expect(refused.page).toContain('"status":"not_invited"')
  expect(refused.sessions).toEqual([])
  expect(await pendingInvitesOf('dave@gmail.com')).toBe(1)
})

test('an invitee whose provider does not confirm the address is refused with the reason and the invite stays pending', async () => {
  await inviteTo(workspaceId, 'erin@gmail.com')
  for (const unconfirmed of [{ email_verified: false }, {}]) {
    const refused = await signIn('erin@gmail.com', { sub: 'erin-subject', email: 'erin@gmail.com', ...unconfirmed })
    expect(refused.status).toBe(403)
    expect(refused.page).toContain('Your provider did not confirm this address')
    expect(refused.sessions).toEqual([])
  }
  expect(await pendingInvitesOf('erin@gmail.com')).toBe(1)
})

test('the database refuses an email domain on a workspace joined by invited address, and a change of who can join once people joined', async () => {
  const domainError =
    await database.$client`insert into sso_domains (workspace_id, domain) values (${workspaceId}, 'gmail.com')`.catch(
      (error: Error) => error,
    )
  expect(String(domainError)).toContain('owns no email domain')
  const changeError =
    await database.$client`update workspaces set join_by = 'domain' where workspace_id = ${workspaceId}`.catch(
      (error: Error) => error,
    )
  expect(String(changeError)).toContain('is chosen at its creation')
})

test('an address with a membership, an open invite or neither gets the same answer from email-first sign-in: the provider of the instance', async () => {
  await inviteTo(workspaceId, 'frank@gmail.com')
  const providerOf = async (email: string) => {
    const login = await app.request(`/auth/login?email=${encodeURIComponent(email)}`)
    const location = new URL(login.headers.get('location') ?? 'http://none')
    return { status: login.status, provider: location.origin + location.pathname }
  }
  const answers = await Promise.all(['owner@gmail.com', 'frank@gmail.com', 'nobody@gmail.com'].map(providerOf))
  expect(answers).toEqual(Array(3).fill({ status: 302, provider: `${issuer}/auth` }))
})

test('email-first sign-in starts every address at the one sign-in app of this Spyria, and an invitee of a second workspace joins it from there', async () => {
  const [owner] = await database.$client`select id from users where email = 'owner@gmail.com'`
  const secondWorkspaceId = crypto.randomUUID()
  await database.$client`
    insert into workspaces (workspace_id, name, created_by, join_by, created_at)
    values (${secondWorkspaceId}, 'Workshop', ${String(owner?.id)}, 'invited_address', now() + interval '1 second')`
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, updated_at)
    select ${secondWorkspaceId}, preset, issuer, client_id, encrypted_client_secret, uses_instance_app, now()
    from workspace_sso where workspace_id = ${workspaceId}`
  await database.$client`
    insert into workspace_roles (workspace_id, id, name, built_in)
    select ${secondWorkspaceId}, id, name, built_in from workspace_roles where workspace_id = ${workspaceId}`
  await database.$client`
    insert into workspace_role_permissions (workspace_id, role_id, permission)
    select ${secondWorkspaceId}, role_id, permission from workspace_role_permissions where workspace_id = ${workspaceId}`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name)
    select ${secondWorkspaceId}, user_id, role, display_name from memberships
    where workspace_id = ${workspaceId} and user_id = ${String(owner?.id)}`
  await database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    values (${secondWorkspaceId}, ${crypto.randomUUID()}, 'gina@gmail.com', 'member', ${String(owner?.id)}, now(),
      now() + interval '7 days')`
  const loginStartOf = async (email: string) => {
    const login = await app.request(`/auth/login?email=${encodeURIComponent(email)}`)
    const loginCookie = login.headers.getSetCookie().find((cookie) => cookie.includes('spyria_login=')) ?? ''
    const signedValue = decodeURIComponent(loginCookie.split(';')[0]?.split('=').slice(1).join('=') ?? '')
    const { providerWorkspaceId } = JSON.parse(signedValue.slice(0, signedValue.lastIndexOf('.')))
    const location = new URL(login.headers.get('location') ?? 'http://none')
    return { login, start: { providerWorkspaceId, clientId: location.searchParams.get('client_id') } }
  }
  const invited = await loginStartOf('gina@gmail.com')
  const nobody = await loginStartOf('nobody@gmail.com')
  expect(invited.start).toEqual(nobody.start)
  expect(invited.start.providerWorkspaceId).toBe(workspaceId)

  const joined = await callbackAfter(invited.login, {
    sub: 'gina-subject',
    email: 'gina@gmail.com',
    email_verified: true,
  })
  expect(joined.sessions.map((session) => session.workspaceId)).toContain(secondWorkspaceId)
  expect(await pendingInvitesOf('gina@gmail.com')).toBe(0)
})

const adminBearer = async () => {
  const [owner] = await database.$client`select id from users where email = 'owner@gmail.com'`
  const [session] = await openSessions(database, String(owner?.id), workspaceId)
  if (!session) throw new Error('The owner has no session')
  return `Bearer ${(await issueSessionToken(testAuthSettings.tokenSecret, session)).token}`
}
const ssoSettingsRequest = async (body?: object) => {
  const response = await app.request('/api/sso-settings', {
    method: body ? 'POST' : 'GET',
    headers: { authorization: await adminBearer(), 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('Setup SSO of a workspace joined by invited address shows the sign-in app of this Spyria and refuses every change to it', async () => {
  const shown = { joinBy: 'invited_address', domain: null, domainState: null, issuer, clientId: 'spyria' }
  expect((await ssoSettingsRequest()).body.settings).toMatchObject(shown)
  const sameApp = { preset: 'oidc', issuer, clientId: 'spyria', clientSecret }
  for (const change of [
    { ...sameApp, clientId: 'spyria-rotated' },
    { ...sameApp, clientSecret: 'another-secret' },
    { ...sameApp, domain: 'gmail.com' },
    { ...sameApp, issuer: 'https://other-idp.example' },
  ])
    expect((await ssoSettingsRequest(change)).body).toMatchObject({
      error: 'sign_in_app_fixed',
      message:
        'Every workspace on this Spyria signs in through one app, which an operator changes with spyria sign-in-app',
    })
  expect((await ssoSettingsRequest()).body.settings).toMatchObject(shown)
})

test('an operator changes the sign-in app of every workspace joined by invited address at once, and members sign in through the new one', async () => {
  const secretBox = createSecretBox(secretsKeyring)
  expect(
    String(await rejectionOf(replaceSignInApp(database, secretBox, { clientId: 'spyria-rotated', clientSecret: ' ' }))),
  ).toContain('A client id and a client secret are required')
  expect(await replaceSignInApp(database, secretBox, { clientId: 'spyria-rotated', clientSecret })).toBe(2)
  expect([
    ...(await database.$client`select distinct client_id from workspace_sso join workspaces using (workspace_id)
      where join_by = 'invited_address'`),
  ]).toEqual([{ client_id: 'spyria-rotated' }])
  expect([
    ...(await database.$client`select type, actor_kind, actor_id from workspace_events
      where workspace_id = ${workspaceId} and type like 'sso.%' order by created_at desc limit 2`),
  ]).toEqual(
    expect.arrayContaining([
      { type: 'sso.configured', actor_kind: 'system', actor_id: 'operator' },
      { type: 'sso.secret_rotated', actor_kind: 'system', actor_id: 'operator' },
    ]),
  )

  const login = await app.request('/auth/login?email=bob%40gmail.com')
  expect(new URL(login.headers.get('location') ?? 'http://none').searchParams.get('client_id')).toBe('spyria-rotated')
  const signedIn = await callbackAfter(login, { sub: 'bob-subject', email: 'bob@gmail.com', email_verified: true })
  expect(signedIn.sessions.map((session) => session.workspaceId)).toContain(workspaceId)
})

test('a sign-in app set in the settings replaces the stored one when the server starts, and nothing happens while they match', async () => {
  const secretBox = createSecretBox(secretsKeyring)
  const ssoEventCount = async () =>
    (await database.$client`select 1 from workspace_events where type like 'sso.%'`).length
  const before = await ssoEventCount()
  expect(await applyConfiguredSignInApp(database, secretBox, { clientId: 'spyria-rotated', clientSecret })).toBe(0)
  expect(await ssoEventCount()).toBe(before)
  expect(await applyConfiguredSignInApp(database, secretBox, { clientId: 'spyria-configured', clientSecret })).toBe(2)
  expect([
    ...(await database.$client`select distinct client_id from workspace_sso join workspaces using (workspace_id)
      where join_by = 'invited_address'`),
  ]).toEqual([{ client_id: 'spyria-configured' }])
  const login = await app.request('/auth/login?email=bob%40gmail.com')
  expect(new URL(login.headers.get('location') ?? 'http://none').searchParams.get('client_id')).toBe(
    'spyria-configured',
  )
})

test("another account at the provider claiming a member's address gets neither that member's account nor a session", async () => {
  const [owner] = await database.$client`select id from users where email = 'owner@gmail.com'`
  const ownerIdentities = async () => [
    ...(await database.$client`select issuer, subject from identities where user_id = ${String(owner?.id)}`),
  ]
  const before = await ownerIdentities()
  const hijack = await signIn('owner@gmail.com', {
    sub: 'attacker-subject',
    email: 'owner@gmail.com',
    email_verified: true,
  })
  expect(hijack.sessions).toEqual([])
  expect(await ownerIdentities()).toEqual(before)
})
