import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds, databaseUrlOf } from '@spyria/db/testing'
import { workspacePermissions } from '@spyria/kernel'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createApp } from '../app.ts'
import { startFakeSmtp, verificationLinkIn } from '../testing/fake-smtp.ts'
import { acme, alice, bob, globex, testAuthSettings, workspaceEventsOf } from '../testing/testing.ts'
import { createSecretBox } from './secret-box.ts'
import { issueSessionToken } from './session-tokens.ts'
import { openSessions } from './sessions.ts'
import { verifyDomainByOperator } from './sso.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const secretsKey = 'sso-integration-secrets-key-0123456789'
const nowInSeconds = () => Math.floor(Date.now() / 1000)

const startFakeIdp = async (issuerPath = '') => {
  const keys = await generateKeyPair('RS256')
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'fake-idp', alg: 'RS256', use: 'sig' }
  const idp = {
    claims: {} as JWTPayload,
    clientSecret: '',
    requests: [] as string[],
    tokenRequests: [] as URLSearchParams[],
  }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, origin } = new URL(request.url)
      const issuer = `${origin}${issuerPath}`
      idp.requests.push(pathname)
      if (pathname === `${issuerPath}/.well-known/openid-configuration`)
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        })
      if (pathname === `${issuerPath}/keys`) return Response.json({ keys: [publicKey] })
      if (pathname !== `${issuerPath}/token`) return new Response(null, { status: 404 })
      const form = new URLSearchParams(await request.text())
      idp.tokenRequests.push(form)
      if (form.get('client_secret') !== idp.clientSecret)
        return Response.json({ error: 'invalid_client' }, { status: 401 })
      const idToken = await new SignJWT({
        iss: issuer,
        aud: form.get('client_id') ?? '',
        iat: nowInSeconds(),
        exp: nowInSeconds() + 60,
        ...idp.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-idp' })
        .sign(keys.privateKey)
      return Response.json({ access_token: 'access', token_type: 'Bearer', id_token: idToken })
    },
  })
  return Object.assign(idp, { origin: server.url.origin, issuer: `${server.url.origin}${issuerPath}`, server })
}
type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>

const acmeIdp = await startFakeIdp()
const otherIdp = await startFakeIdp()
const entraIdp = await startFakeIdp('/tenant-1/v2.0')
const bootstrapIdp = await startFakeIdp()
const smtp = startFakeSmtp()
const ssoSettings = { ...testAuthSettings, authMode: 'sso' as const, secretsKey, microsoftLoginOrigin: entraIdp.origin }
const app = createApp({ database, ...ssoSettings, mail: { smtpUrl: smtp.url, from: 'Spyria <spyria@test.local>' } })
const appWithoutMail = createApp({ database, ...ssoSettings })
afterAll(async () => {
  smtp.stop()
  for (const idp of [acmeIdp, otherIdp, entraIdp, bootstrapIdp]) await idp.server.stop(true)
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const bearerOf = async (workspaceId: string, userId: string) => {
  const [session] = await openSessions(database, userId, workspaceId)
  if (!session) throw new Error(`${userId} is not a member of ${workspaceId}`)
  return `Bearer ${(await issueSessionToken(testAuthSettings.tokenSecret, session)).token}`
}
const saveSso = async (workspaceId: string, settings: object, userId = alice) => {
  const response = await app.request('/api/sso-settings', {
    method: 'POST',
    headers: { authorization: await bearerOf(workspaceId, userId), 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
  return { status: response.status, body: await response.text() }
}
const sendVerification = async (workspaceId: string, domain: string, email: string, server = app) => {
  const response = await server.request('/api/sso-settings/domain-verification', {
    method: 'POST',
    headers: { authorization: await bearerOf(workspaceId, alice), 'content-type': 'application/json' },
    body: JSON.stringify({ domain, email }),
  })
  return { status: response.status, body: await response.json() }
}
const lastLinkTo = (email: string) => verificationLinkIn(smtp.mails.findLast((mail) => mail.to.includes(email)))
const openLink = async (link: string) => {
  const response = await app.request(new URL(link).pathname + new URL(link).search)
  return { status: response.status, page: await response.text() }
}
const runOperator = async (args: string[], environment: Record<string, string> = {}) => {
  const operator = Bun.spawn([process.execPath, new URL('../operator-cli.ts', import.meta.url).pathname, ...args], {
    stderr: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrlOf(testDatabase.name), ...environment },
  })
  return {
    exitCode: await operator.exited,
    stdout: await new Response(operator.stdout).text(),
    stderr: await new Response(operator.stderr).text(),
  }
}
const unverified = (domain: string) => ({ domain, isVerified: false, sentTo: null, expiresAt: null })
const readSso = async (workspaceId: string, userId = alice) => {
  const response = await app.request('/api/sso-settings', {
    headers: { authorization: await bearerOf(workspaceId, userId) },
  })
  return { status: response.status, body: await response.text() }
}
const configureIdp = (idp: FakeIdp, workspaceId: string, domains: string[], clientSecret = `${workspaceId}-secret`) => {
  idp.clientSecret = clientSecret
  return saveSso(workspaceId, {
    preset: 'oidc',
    issuer: idp.issuer,
    clientId: `spyria-${workspaceId}`,
    clientSecret,
    domains,
  })
}
const addWorkspace = async (workspaceId: string) => {
  await database.$client`
    insert into workspaces (workspace_id, name, created_by, created_at) values (${workspaceId}, ${workspaceId}, ${alice}, now())`
  await database.$client`
    insert into workspace_roles (workspace_id, id, name, built_in)
    values (${workspaceId}, 'admin', 'Admin', true), (${workspaceId}, 'member', 'Member', true)`
  await database.$client`
    insert into workspace_role_permissions (workspace_id, role_id, permission)
    select ${workspaceId}, 'admin', unnest(${database.$client.array([...workspacePermissions])}::text[])`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${workspaceId}, ${alice}, 'admin', 'Alice')`
}
const invite = (workspaceId: string, email: string) =>
  database.$client`
    insert into invitations (workspace_id, id, email, role, invited_by, created_at, expires_at)
    values (${workspaceId}, ${crypto.randomUUID()}, ${email}, 'member', ${alice}, now(), now() + interval '7 days')`

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')
const sessionsOf = async (cookie: string) =>
  (await (await app.request('/auth/sessions', { headers: { cookie } })).json()) as {
    userId?: string
    sessions: { workspaceId: string }[]
  }
const signInThrough = async (idp: FakeIdp, loginQuery: string, claims: JWTPayload) => {
  const login = await app.request(`/auth/login?${loginQuery}`)
  const location = new URL(login.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(`${idp.issuer}/auth`)
  idp.claims = { nonce: location.searchParams.get('nonce') ?? '', ...claims }
  const response = await app.request(`/auth/callback?code=code-1&state=${location.searchParams.get('state')}`, {
    headers: { cookie: cookieHeaderOf(login) },
  })
  const cookie = cookieHeaderOf(response)
  return { status: response.status, page: await response.text(), ...(await sessionsOf(cookie)) }
}
const identitiesOf = async (subject: string) => [
  ...(await database.$client`
    select workspace_id, issuer, user_id from identities where subject = ${subject} order by workspace_id`),
]

test('the server tells its auth mode', async () => {
  expect(await (await app.request('/auth/mode')).json()).toEqual({ authMode: 'sso' })
  expect(await (await createApp({ database, ...testAuthSettings }).request('/auth/mode')).json()).toEqual({
    authMode: 'dex',
  })
})

test('an admin saves the SSO settings: the secret is encrypted at rest, never returned, and changes are recorded', async () => {
  const saved = await configureIdp(acmeIdp, acme, [' Example.com'], 'acme-secret-1')
  expect(saved.status).toBe(200)
  const view = { preset: 'oidc', issuer: acmeIdp.issuer, clientId: `spyria-${acme}`, domains: ['example.com'] }
  expect(JSON.parse(saved.body)).toEqual({
    settings: { ...view, tenantId: '', hasSecret: true, domainStates: [unverified('example.com')] },
  })
  const [stored] = await database.$client<{ encryptedClientSecret: string }[]>`
    select encrypted_client_secret as "encryptedClientSecret" from workspace_sso where workspace_id = ${acme}`
  expect(stored?.encryptedClientSecret).not.toContain('acme-secret-1')
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('acme-secret-1')

  expect((await saveSso(acme, { ...view, domains: ['example.com', 'example.org'] })).status).toBe(200)
  expect((await saveSso(acme, { ...view, clientSecret: 'acme-secret-2' })).status).toBe(200)
  acmeIdp.clientSecret = 'acme-secret-2'
  for (const read of [await readSso(acme), saved]) {
    expect(read.body).not.toContain('acme-secret')
    expect(read.body).not.toContain(stored?.encryptedClientSecret ?? '')
  }
  expect(JSON.parse((await readSso(acme)).body).settings).toEqual({
    ...view,
    tenantId: '',
    hasSecret: true,
    domainStates: [unverified('example.com')],
  })
  expect(
    (await workspaceEventsOf(database))
      .filter((event) => event.type.startsWith('sso.'))
      .map(({ type, actorId }) => [type, actorId]),
  ).toEqual([
    ['sso.configured', alice],
    ['sso.configured', alice],
    ['sso.configured', alice],
    ['sso.secret_rotated', alice],
  ])
  expect(
    (await database.$client`select tablename from pg_publication_tables where pubname = 'hq_zero'`).map(
      ({ tablename }) => tablename,
    ),
  ).not.toContain('workspace_sso')
  expect((await readSso(acme, bob)).status).toBe(403)
  expect((await saveSso(acme, view, bob)).status).toBe(403)
})

test('saving refuses a failing discovery with its reason, a multi-tenant Entra issuer and a first save without secret', async () => {
  const unreachable = await saveSso(globex, {
    preset: 'oidc',
    issuer: 'http://127.0.0.1:9/nothing',
    clientId: 'spyria',
    clientSecret: 's',
    domains: ['globex.com'],
  })
  expect(unreachable.status).toBe(400)
  expect(JSON.parse(unreachable.body)).toMatchObject({
    error: 'sso_discovery_failed',
    message: expect.stringMatching(/^The discovery of http:\/\/127\.0\.0\.1:9\/nothing failed: .+/),
  })
  const common = await saveSso(globex, {
    preset: 'microsoft',
    tenantId: 'common',
    clientId: 'spyria',
    clientSecret: 's',
    domains: ['globex.com'],
  })
  expect(JSON.parse(common.body)).toEqual({
    error: 'invalid_sso_settings',
    message: 'Only a tenant-specific Microsoft Entra issuer is accepted',
  })
  const withoutSecret = await saveSso(globex, {
    preset: 'oidc',
    issuer: otherIdp.issuer,
    clientId: 'spyria',
    domains: ['globex.com'],
  })
  expect(JSON.parse(withoutSecret.body).message).toBe('A client secret is required')
  expect([...(await database.$client`select 1 from workspace_sso where workspace_id = ${globex}`)]).toEqual([])
})

test('an unknown domain is refused before any redirect to a provider', async () => {
  const requestCount = acmeIdp.requests.length
  const login = await app.request('/auth/login?email=pat@Other.com')
  expect(login.status).toBe(404)
  expect(login.headers.get('location')).toBeNull()
  expect(await login.text()).toContain('"status":"unknown_domain","domain":"other.com"')
  expect(acmeIdp.requests.length).toBe(requestCount)
})

test('a domain verifies through a single-use emailed link; until then it does not route sign-in', async () => {
  expect((await app.request('/auth/login?email=nina@example.com')).status).toBe(404)
  expect((await sendVerification(acme, 'example.com', 'it@other.com')).body).toEqual({
    error: 'invalid_sso_settings',
    message: 'Enter an address at example.com',
  })
  const sent = await sendVerification(acme, 'example.com', 'IT@example.com')
  expect(sent.status).toBe(200)
  const [pending] = sent.body.settings.domainStates
  expect(pending).toMatchObject({ domain: 'example.com', isVerified: false, sentTo: 'it@example.com' })
  expect(pending.expiresAt).toBeGreaterThan(Date.now() + 23.9 * 60 * 60 * 1000)
  expect(pending.expiresAt).toBeLessThan(Date.now() + 24.1 * 60 * 60 * 1000)
  const firstLink = lastLinkTo('it@example.com')
  expect(firstLink).toStartWith(`${testAuthSettings.appOrigin}/auth/verify-domain?token=`)
  const [stored] = await database.$client<{ hash: string }[]>`
    select verification_token_hash as hash from sso_domains where workspace_id = ${acme}`
  expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(firstLink).not.toContain(stored?.hash ?? '')

  const invalid = 'This verification link is invalid, used or expired. Send a new one from Workspace settings.'
  expect(await openLink(`${firstLink}x`)).toEqual({ status: 400, page: expect.stringContaining(invalid) })
  await sendVerification(acme, 'example.com', 'it@example.com')
  expect(await openLink(firstLink)).toEqual({ status: 400, page: expect.stringContaining(invalid) })
  await database.$client`update sso_domains set verification_expires_at = now() - interval '1 second'`
  expect(await openLink(lastLinkTo('it@example.com'))).toEqual({ status: 400, page: expect.stringContaining(invalid) })

  await sendVerification(acme, 'example.com', 'it@example.com')
  const link = lastLinkTo('it@example.com')
  expect(await openLink(link)).toEqual({
    status: 200,
    page: expect.stringContaining('example.com is verified: people with an example.com email can now sign in'),
  })
  expect(await openLink(link)).toEqual({ status: 400, page: expect.stringContaining(invalid) })
  const verifiedEvent = (await workspaceEventsOf(database)).at(-1)
  expect(verifiedEvent?.actorId).toBeNull()
  expect(verifiedEvent).toMatchObject({
    type: 'sso.domain_verified',
    payload: { domain: 'example.com', email: 'it@example.com' },
  })
  expect(JSON.parse((await readSso(acme)).body).settings.domainStates).toEqual([
    { domain: 'example.com', isVerified: true, sentTo: null, expiresAt: null },
  ])
  expect((await app.request('/auth/login?email=nina@example.com')).status).toBe(302)
})

test('without SMTP the verification link is refused with a clear message', async () => {
  await database.$client`insert into sso_domains (workspace_id, domain) values (${acme}, 'example.net')`
  expect((await sendVerification(acme, 'example.net', 'it@example.net', appWithoutMail)).body).toEqual({
    error: 'mail_not_configured',
    message:
      'Email is not configured on this server (SPYRIA_SMTP_URL): the operator can verify the domain with sso:verify-domain',
  })
  await database.$client`delete from sso_domains where domain = 'example.net'`
})

test('the first sign-in binds the identity through an invite; a later sign-in matches the subject after an email change', async () => {
  await invite(acme, 'nina@example.com')
  const first = await signInThrough(acmeIdp, 'email=nina@example.com', {
    sub: 'nina-subject',
    email: 'nina@example.com',
  })
  expect(first.page).toContain('"status":"signed_in"')
  expect(first.sessions.map(({ workspaceId }) => workspaceId)).toEqual([acme])
  expect(Object.fromEntries(acmeIdp.tokenRequests.at(-1) ?? [])).toMatchObject({
    client_id: `spyria-${acme}`,
    client_secret: 'acme-secret-2',
    code_verifier: expect.any(String),
  })
  expect(await identitiesOf('nina-subject')).toEqual([
    { workspace_id: acme, issuer: acmeIdp.issuer, user_id: first.userId },
  ])
  const renamed = await signInThrough(acmeIdp, 'email=nina.new@example.com', {
    sub: 'nina-subject',
    email: 'nina.new@example.com',
  })
  expect(renamed.page).toContain('"status":"signed_in"')
  expect(renamed.userId).toBe(first.userId)
  expect([...(await database.$client`select 1 from users where email = 'nina.new@example.com'`)]).toEqual([])
})

test('an email outside the domains or without membership and invite is refused', async () => {
  await invite(acme, 'quinn@elsewhere.com')
  for (const email of ['quinn@elsewhere.com', 'olive@example.com']) {
    const refused = await signInThrough(acmeIdp, 'email=quinn@example.com', { sub: `${email}-subject`, email })
    expect(refused.status).toBe(403)
    expect(refused.page).toContain(`"status":"not_invited","email":"${email}"`)
    expect(refused.sessions).toEqual([])
    expect(await identitiesOf(`${email}-subject`)).toEqual([])
  }
})

test('an Entra token without email_verified signs in by preferred_username for a configured tenant issuer', async () => {
  await addWorkspace('initech')
  entraIdp.clientSecret = 'entra-secret'
  const saved = await saveSso('initech', {
    preset: 'microsoft',
    tenantId: 'tenant-1',
    clientId: 'spyria-initech',
    clientSecret: 'entra-secret',
    domains: ['initech.com'],
  })
  expect(JSON.parse(saved.body).settings).toMatchObject({ issuer: entraIdp.issuer, tenantId: 'tenant-1' })
  await verifyDomainByOperator(database, 'initech', 'initech.com')
  await invite('initech', 'peter@initech.com')
  const signedIn = await signInThrough(entraIdp, 'email=peter@initech.com', {
    sub: 'peter-subject',
    preferred_username: 'Peter@initech.com',
  })
  expect(signedIn.page).toContain('"status":"signed_in"')
  expect(signedIn.sessions.map(({ workspaceId }) => workspaceId)).toEqual(['initech'])
})

test('a domain claimed by another issuer is refused; the same issuer shares it and one sign-in opens both workspaces', async () => {
  const claimed = await configureIdp(otherIdp, globex, ['example.com'])
  expect(JSON.parse(claimed.body)).toEqual({
    error: 'domain_claimed',
    message: 'example.com already signs in through another provider',
  })
  expect(
    (
      await saveSso(globex, {
        preset: 'oidc',
        issuer: acmeIdp.issuer,
        clientId: 'spyria-globex',
        clientSecret: 'acme-secret-2',
        domains: ['example.com'],
      })
    ).status,
  ).toBe(200)
  const verified = await runOperator(['sso:verify-domain', '--workspace', globex, '--domain', 'example.com'])
  expect(verified).toEqual({ exitCode: 0, stdout: `example.com is verified for workspace ${globex}\n`, stderr: '' })
  const aliceSignIn = await signInThrough(acmeIdp, 'email=alice@example.com', {
    sub: 'alice-subject',
    email: 'alice@example.com',
  })
  expect(aliceSignIn.userId).toBe(alice)
  expect(aliceSignIn.sessions.map(({ workspaceId }) => workspaceId)).toEqual([acme, globex])
  expect((await identitiesOf('alice-subject')).map(({ workspace_id }) => workspace_id)).toEqual([acme, globex])
})

test('an unverified claim blocks no one; a verified domain refuses another issuer at save and at verification', async () => {
  await addWorkspace('hooli')
  await addWorkspace('pied-piper')
  expect((await configureIdp(otherIdp, 'hooli', ['shared.com'])).status).toBe(200)
  expect((await configureIdp(entraIdp, 'pied-piper', ['shared.com'])).status).toBe(200)
  expect((await app.request('/auth/login?email=pat@shared.com')).status).toBe(404)
  await verifyDomainByOperator(database, 'hooli', 'shared.com')
  await expect(verifyDomainByOperator(database, 'pied-piper', 'shared.com')).rejects.toThrow(
    'shared.com already signs in through another provider',
  )
  await sendVerification('pied-piper', 'shared.com', 'it@shared.com')
  expect(await openLink(lastLinkTo('it@shared.com'))).toEqual({
    status: 400,
    page: expect.stringContaining('shared.com already signs in through another provider'),
  })
  expect(JSON.parse((await configureIdp(entraIdp, 'pied-piper', ['shared.com'])).body).error).toBe('domain_claimed')
  const login = await app.request('/auth/login?email=pat@shared.com')
  expect(new URL(login.headers.get('location') ?? '').origin).toBe(otherIdp.origin)
})

test('the test sign-in hook works in sso mode', async () => {
  const testApp = createApp({ database, ...ssoSettings, testDatabaseByName: () => database })
  const testCookie = `spyria_test=${encodeURIComponent(JSON.stringify({ db: testDatabase.name, user: bob }))}`
  const login = await testApp.request('/auth/login', { headers: { cookie: testCookie } })
  expect(await login.text()).toContain('"status":"signed_in"')
  expect(cookieHeaderOf(login)).toContain(`spyria_s_${acme}=`)
})

test('the operator bootstrap creates a workspace with its SSO and a first admin who signs in through it', async () => {
  bootstrapIdp.clientSecret = 'bootstrap-secret'
  const bootstrap = await runOperator(
    [
      'sso:bootstrap',
      '--name',
      'Umbrella',
      '--admin',
      'Carol@umbrella.com',
      '--preset',
      'oidc',
      '--issuer',
      bootstrapIdp.issuer,
      '--client-id',
      'spyria-umbrella',
      '--domains',
      'umbrella.com',
    ],
    { SPYRIA_SECRETS_KEY: secretsKey, SPYRIA_SSO_CLIENT_SECRET: 'bootstrap-secret' },
  )
  expect(bootstrap.exitCode).toBe(0)
  expect(bootstrap.stderr).toBe('')
  const [workspace] = await database.$client<{ workspaceId: string }[]>`
    select workspace_id as "workspaceId" from workspaces where name = 'Umbrella'`
  const workspaceId = workspace?.workspaceId ?? ''
  expect(bootstrap.stdout).toContain(`Workspace Umbrella (${workspaceId}) is created`)
  expect([
    ...(await database.$client`
      select users.email, role, display_name from memberships join users on users.id = memberships.user_id
      where workspace_id = ${workspaceId}`),
  ]).toEqual([{ email: 'carol@umbrella.com', role: 'admin', display_name: 'carol' }])
  expect((await workspaceEventsOf(database, workspaceId)).map(({ type }) => type)).toEqual([
    'member.joined',
    'sso.configured',
  ])
  expect([
    ...(await database.$client`select domain from sso_domains where workspace_id = ${workspaceId} and verified_at is not null`),
  ]).toEqual([{ domain: 'umbrella.com' }])
  const signedIn = await signInThrough(bootstrapIdp, 'email=carol@umbrella.com', {
    sub: 'carol-subject',
    email: 'carol@umbrella.com',
  })
  expect(signedIn.sessions.map((session) => session.workspaceId)).toEqual([workspaceId])
})
