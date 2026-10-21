import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds, databaseUrlOf } from '@spyria/db/testing'
import { workspacePermissions } from '@spyria/kernel'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { createApp } from '../app.ts'
import { rateBudgets } from '../rate-limits.ts'
import { startFakeSmtp, verificationLinkIn } from '../testing/fake-smtp.ts'
import { acme, alice, bob, captureLogs, globex, testAuthSettings, workspaceEventsOf } from '../testing/testing.ts'
import { createSmtpMailer } from './mail.ts'
import { createSecretBox } from './secret-box.ts'
import { issueSessionToken } from './session-tokens.ts'
import { openSessions } from './sessions.ts'
import { verifyDomainByOperator } from './sso.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const emptyInstance = await createTestDatabase()
await emptyInstance.database.$client`truncate workspaces, users cascade`
const secretsKey = 'sso-integration-secrets-key-0123456789'
const nowInSeconds = () => Math.floor(Date.now() / 1000)

const startFakeIdp = async (issuerPath = '') => {
  const keys = await generateKeyPair('RS256')
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'fake-idp', alg: 'RS256', use: 'sig' }
  const idp = {
    claims: {} as JWTPayload,
    claimsByCode: new Map<string, JWTPayload>(),
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
        ...(idp.claimsByCode.get(form.get('code') ?? '') ?? idp.claims),
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
const firstWorkspaceIdp = Object.assign(await startFakeIdp(), { clientSecret: 'umbrella-secret' })
const smtp = startFakeSmtp()
const ssoSettings = { ...testAuthSettings, authMode: 'sso' as const, secretsKey, microsoftLoginOrigin: entraIdp.origin }
const app = createApp({ database, ...ssoSettings, mail: { smtpUrl: smtp.url, from: 'Spyria <spyria@test.local>' } })
const appWithoutMail = createApp({ database, ...ssoSettings })
const emptyInstanceApp = createApp({ database: emptyInstance.database, ...ssoSettings })
afterAll(async () => {
  await emptyInstance.drop()
  smtp.stop()
  for (const idp of [acmeIdp, otherIdp, entraIdp, firstWorkspaceIdp]) await idp.server.stop(true)
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
const configureIdp = (idp: FakeIdp, workspaceId: string, domain: string, clientSecret = `${workspaceId}-secret`) => {
  idp.clientSecret = clientSecret
  return saveSso(workspaceId, {
    preset: 'oidc',
    issuer: idp.issuer,
    clientId: `spyria-${workspaceId}`,
    clientSecret,
    domain,
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
const sessionsOf = async (cookie: string, server = app) =>
  (await (await server.request('/auth/sessions', { headers: { cookie } })).json()) as {
    userId?: string
    sessions: { workspaceId: string }[]
  }
const signInThrough = async (idp: FakeIdp, loginQuery: string, claims: JWTPayload, server = app) => {
  const login = await server.request(`/auth/login?${loginQuery}`)
  const location = new URL(login.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(`${idp.issuer}/auth`)
  idp.claims = { nonce: location.searchParams.get('nonce') ?? '', ...claims }
  const response = await server.request(`/auth/callback?code=code-1&state=${location.searchParams.get('state')}`, {
    headers: { cookie: cookieHeaderOf(login) },
  })
  const cookie = cookieHeaderOf(response)
  return { status: response.status, page: await response.text(), ...(await sessionsOf(cookie, server)) }
}
const identitiesOf = async (subject: string) => [
  ...(await database.$client`
    select workspace_id, issuer, user_id from identities where subject = ${subject} order by workspace_id`),
]

test('the server tells its auth mode and whether a workspace can be created', async () => {
  expect(await (await app.request('/auth/mode')).json()).toEqual({ authMode: 'sso', canCreateWorkspace: false })
  expect(await (await emptyInstanceApp.request('/auth/mode')).json()).toEqual({
    authMode: 'sso',
    canCreateWorkspace: true,
  })
  expect(
    await (await createApp({ database: emptyInstance.database, ...testAuthSettings }).request('/auth/mode')).json(),
  ).toEqual({ authMode: 'dex', canCreateWorkspace: false })
})

test('an admin saves the SSO settings: the secret is encrypted at rest, never returned, and changes are recorded', async () => {
  const saved = await configureIdp(acmeIdp, acme, ' Example.com', 'acme-secret-1')
  expect(saved.status).toBe(200)
  const view = { preset: 'oidc', issuer: acmeIdp.issuer, clientId: `spyria-${acme}`, domain: 'example.com' }
  expect(JSON.parse(saved.body)).toEqual({
    settings: { ...view, tenantId: '', hasSecret: true, domainState: unverified('example.com') },
  })
  const [stored] = await database.$client<{ encryptedClientSecret: string }[]>`
    select encrypted_client_secret as "encryptedClientSecret" from workspace_sso where workspace_id = ${acme}`
  expect(stored?.encryptedClientSecret).not.toContain('acme-secret-1')
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('acme-secret-1')

  expect((await saveSso(acme, { ...view, clientId: `spyria-${acme}-2` })).status).toBe(200)
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
    domainState: unverified('example.com'),
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
    (await database.$client`select tablename from pg_publication_tables where pubname = 'spyria_zero'`).map(
      ({ tablename }) => tablename,
    ),
  ).not.toContain('workspace_sso')
  expect((await readSso(acme, bob)).status).toBe(403)
  expect((await saveSso(acme, view, bob)).status).toBe(403)
})

test('the email domain is set when the workspace is created: saving refuses adding, changing or removing it', async () => {
  const view = { preset: 'oidc', issuer: acmeIdp.issuer, clientId: `spyria-${acme}` }
  for (const domain of ['example.com, example.org', 'example.org', ''])
    expect(await saveSso(acme, { ...view, domain })).toEqual({
      status: 400,
      body: JSON.stringify({
        error: 'domain_fixed',
        message:
          'The email domain of this workspace is example.com: it is set when the workspace is created and cannot be changed',
      }),
    })
  expect([...(await database.$client`select domain from sso_domains where workspace_id = ${acme}`)]).toEqual([
    { domain: 'example.com' },
  ])
})

test('saving refuses a failing discovery with its reason, a multi-tenant Entra issuer and a first save without secret', async () => {
  const unreachable = await saveSso(globex, {
    preset: 'oidc',
    issuer: 'http://127.0.0.1:9/nothing',
    clientId: 'spyria',
    clientSecret: 's',
    domain: 'globex.com',
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
    domain: 'globex.com',
  })
  expect(JSON.parse(common.body)).toEqual({
    error: 'invalid_sso_settings',
    message: 'Only a tenant-specific Microsoft Entra issuer is accepted',
  })
  const withoutSecret = await saveSso(globex, {
    preset: 'oidc',
    issuer: otherIdp.issuer,
    clientId: 'spyria',
    domain: 'globex.com',
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
  const pending = sent.body.settings.domainState
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

  const storedHash = async () =>
    (
      await database.$client<{ hash: string | null }[]>`
        select verification_token_hash as hash from sso_domains where workspace_id = ${acme}`
    )[0]?.hash
  const appMailingThrough = ({ url }: { url: string }) =>
    createApp({ database, ...ssoSettings, mail: { smtpUrl: url, from: 'Spyria <spyria@test.local>' } })
  const slowSmtp = startFakeSmtp(0, { greetingDelayMilliseconds: 1_000 })
  const droppingSmtp = startFakeSmtp(0, { dropsAfterMessage: true })
  try {
    const hashBeforeSlowSend = await storedHash()
    const slowSend = sendVerification(acme, 'example.com', 'it@example.com', appMailingThrough(slowSmtp))
    const startedAt = Date.now()
    while ((await storedHash()) === hashBeforeSlowSend && Date.now() - startedAt < 900) await Bun.sleep(10)
    expect(await storedHash()).not.toBe(hashBeforeSlowSend)
    expect(slowSmtp.mails).toHaveLength(0)
    expect((await slowSend).status).toBe(200)
    expect(slowSmtp.mails).toHaveLength(1)
    const hashOfDeliveredLink = await storedHash()
    expect(
      await sendVerification(acme, 'example.com', 'it@example.com', appMailingThrough(droppingSmtp)),
    ).toMatchObject({
      body: { error: 'mail_not_sent' },
    })
    expect(await storedHash()).toBe(hashOfDeliveredLink)
    expect(droppingSmtp.mails).toHaveLength(1)
    expect(await openLink(verificationLinkIn(droppingSmtp.mails[0]))).toEqual({
      status: 400,
      page: expect.stringContaining(invalid),
    })
  } finally {
    slowSmtp.stop()
    droppingSmtp.stop()
  }

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
  expect(JSON.parse((await readSso(acme)).body).settings.domainState).toEqual({
    domain: 'example.com',
    isVerified: true,
    sentTo: null,
    expiresAt: null,
  })
  expect((await app.request('/auth/login?email=nina@example.com')).status).toBe(302)
})

test('without SMTP the verification link is refused with a clear message', async () => {
  expect((await sendVerification(acme, 'example.com', 'it@example.com', appWithoutMail)).body).toEqual({
    error: 'mail_not_configured',
    message:
      'Email is not configured on this server (SPYRIA_SMTP_URL): the operator can verify the domain with sso:verify-domain',
  })
})

test('a workspace sends at most 3 verification emails an hour: the next is refused with 429, Retry-After and a message, another workspace is not', async () => {
  const limitedApp = createApp({
    database,
    ...ssoSettings,
    rateLimits: rateBudgets,
    mail: { smtpUrl: smtp.url, from: 'Spyria <spyria@test.local>' },
  })
  const logs = captureLogs()
  try {
    for (let sent = 0; sent < 3; sent++)
      expect((await sendVerification(acme, 'example.com', 'it@example.com', limitedApp)).status).not.toBe(429)
    const response = await limitedApp.request('/api/sso-settings/domain-verification', {
      method: 'POST',
      headers: { authorization: await bearerOf(acme, alice), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com', email: 'it@example.com' }),
    })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBe(1200)
    expect(await response.json()).toEqual({
      error: 'rate_limited',
      message: 'Too many requests: try again in 1200 seconds.',
    })
    expect((await sendVerification(globex, 'globex.com', 'it@globex.com', limitedApp)).status).not.toBe(429)
  } finally {
    logs.restore()
  }
  expect(logs.events.filter((logged) => logged.event === 'rate_limit.hit')).toEqual([
    expect.objectContaining({
      severity: 'WARN',
      attributes: { 'rate_limit.name': 'verificationEmails', 'workspace.id': acme },
    }),
  ])
})

test('a mail is retried while the SMTP connection is refused, and never sent twice once the server has the message', async () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
  const { port } = probe
  probe.stop(true)
  const mail = { to: 'it@example.com', subject: 'Verify', text: 'Open the link' }
  const startedAt = Date.now()
  const sent = createSmtpMailer({ smtpUrl: `smtp://127.0.0.1:${port}`, from: 'Spyria <spyria@test.local>' }).send(mail)
  await Bun.sleep(50)
  const lateSmtp = startFakeSmtp(port)
  try {
    await sent
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(lateSmtp.mails.map((received) => received.to)).toEqual([['it@example.com']])
  } finally {
    lateSmtp.stop()
  }
  const droppingSmtp = startFakeSmtp(0, { dropsAfterMessage: true })
  try {
    await expect(
      createSmtpMailer({ smtpUrl: droppingSmtp.url, from: 'Spyria <spyria@test.local>' }).send(mail),
    ).rejects.toThrow()
    await Bun.sleep(300)
    expect(droppingSmtp.mails).toHaveLength(1)
  } finally {
    droppingSmtp.stop()
  }
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
    domain: 'initech.com',
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
  const claimed = await configureIdp(otherIdp, globex, 'example.com')
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
        domain: 'example.com',
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
  expect((await configureIdp(otherIdp, 'hooli', 'shared.com')).status).toBe(200)
  expect((await configureIdp(entraIdp, 'pied-piper', 'shared.com')).status).toBe(200)
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
  expect(JSON.parse((await configureIdp(entraIdp, 'pied-piper', 'shared.com')).body).error).toBe('domain_claimed')
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

const umbrellaForm = () => ({
  name: ' Umbrella ',
  domain: 'Umbrella.com',
  preset: 'oidc',
  issuer: firstWorkspaceIdp.issuer,
  clientId: 'spyria-umbrella',
  clientSecret: 'umbrella-secret',
})
const startCreation = (form: Record<string, string>, origin = testAuthSettings.appOrigin) =>
  emptyInstanceApp.request('/auth/first-workspace', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams(form),
  })
const completeCreation = async (started: Response, code: string, claims: JWTPayload) => {
  const location = new URL(started.headers.get('location') ?? '')
  expect(location.origin + location.pathname).toBe(`${firstWorkspaceIdp.issuer}/auth`)
  firstWorkspaceIdp.claimsByCode.set(code, { nonce: location.searchParams.get('nonce') ?? '', ...claims })
  const response = await emptyInstanceApp.request(
    `/auth/callback?code=${code}&state=${location.searchParams.get('state')}`,
    { headers: { cookie: cookieHeaderOf(started) } },
  )
  return { status: response.status, page: await response.text(), cookie: cookieHeaderOf(response) }
}
const countsOf = async () =>
  (
    await emptyInstance.database.$client`
      select (select count(*) from workspaces)::int as workspaces, (select count(*) from users)::int as users`
  )[0]

test('sign-in routing, the sign-in callback, workspace creation and the verification link answer 429 with Retry-After past their budget per address', async () => {
  const limitedApp = createApp({ database: emptyInstance.database, ...ssoSettings, rateLimits: rateBudgets })
  const requests = {
    emailRouting: () => limitedApp.request('/auth/login?email=pat@other.com'),
    signInCallback: () => limitedApp.request('/auth/callback?code=forged&state=forged'),
    firstWorkspace: () =>
      limitedApp.request('/auth/first-workspace', { method: 'POST', headers: { origin: 'https://elsewhere.example' } }),
    verificationLink: () => limitedApp.request('/auth/verify-domain?token=forged'),
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
  } finally {
    logs.restore()
  }
  expect(await countsOf()).toEqual({ workspaces: 0, users: 0 })
  expect(logs.events.filter((logged) => logged.event === 'rate_limit.hit').map((logged) => logged.attributes)).toEqual(
    Object.keys(requests).map((name) => ({ 'rate_limit.name': name })),
  )
})

test('on an empty instance, creating a workspace refuses another origin, invalid settings, a failing discovery and an email outside the domain, creating nothing', async () => {
  expect((await startCreation(umbrellaForm(), 'https://elsewhere.example')).status).toBe(403)
  for (const [change, reason] of [
    [{ name: ' ' }, 'A name must contain at least one non-blank character'],
    [{ domain: 'umbrella' }, 'umbrella is not an email domain'],
    [{ clientSecret: '' }, 'A client secret is required'],
    [{ preset: 'microsoft', tenantId: 'common' }, 'Only a tenant-specific Microsoft Entra issuer is accepted'],
    [{ issuer: 'http://127.0.0.1:9/nothing' }, 'The discovery of http://127.0.0.1:9/nothing failed: '],
  ] as const) {
    const refused = await startCreation({ ...umbrellaForm(), ...change })
    expect(refused.status).toBe(400)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.text()).toContain(`"status":"refused","message":"${reason}`)
  }
  const started = await startCreation(umbrellaForm())
  expect(started.headers.get('set-cookie')).not.toContain('umbrella-secret')
  const outside = await completeCreation(started, 'outside', { sub: 'mallory-subject', email: 'mallory@elsewhere.com' })
  expect(outside.status).toBe(403)
  expect(outside.page).toContain('mallory@elsewhere.com is not an address at umbrella.com: no workspace was created')
  expect(await countsOf()).toEqual({ workspaces: 0, users: 0 })
})

test('the first person completing sign-in becomes the Admin of an unverified workspace: of two at once exactly one wins, then creation is closed; while it is the only workspace its unverified domain routes its Admin back in by email and admits nobody new, and once a second workspace exists only a verified domain routes', async () => {
  const [carolStart, daveStart] = [await startCreation(umbrellaForm()), await startCreation(umbrellaForm())]
  const [carol, dave] = await Promise.all([
    completeCreation(carolStart as Response, 'carol', { sub: 'carol-subject', email: 'Carol@umbrella.com' }),
    completeCreation(daveStart as Response, 'dave', { sub: 'dave-subject', email: 'dave@umbrella.com' }),
  ])
  const [winner, loser] = carol.status === 200 ? [carol, dave] : [dave, carol]
  expect(winner?.page).toContain('"status":"signed_in"')
  expect(loser?.status).toBe(403)
  expect(loser?.page).toContain('Workspace creation is closed on this instance')
  expect(await countsOf()).toEqual({ workspaces: 1, users: 1 })
  const [member] = await emptyInstance.database.$client<
    { workspaceId: string; userId: string; email: string; role: string; displayName: string; name: string }[]
  >`
    select workspace_id as "workspaceId", user_id as "userId", users.email, role, display_name as "displayName",
      workspaces.name
    from memberships join users on users.id = memberships.user_id join workspaces using (workspace_id)`
  const { workspaceId, userId } = member ?? { workspaceId: '', userId: '' }
  expect(member).toMatchObject({
    name: 'Umbrella',
    role: 'admin',
    email: winner === carol ? 'carol@umbrella.com' : 'dave@umbrella.com',
  })
  const sessions = await (
    await emptyInstanceApp.request('/auth/sessions', { headers: { cookie: winner?.cookie ?? '' } })
  ).json()
  expect(sessions).toMatchObject({ userId, sessions: [{ workspaceId }] })
  expect(
    (await workspaceEventsOf(emptyInstance.database, workspaceId)).map(({ type, actorId }) => [type, actorId]),
  ).toEqual([
    ['member.joined', userId],
    ['sso.configured', userId],
  ])
  const [stored] = await emptyInstance.database.$client`
    select issuer, client_id as "clientId", encrypted_client_secret as "encryptedClientSecret", domain, verified_at as "verifiedAt"
    from workspace_sso join sso_domains using (workspace_id)`
  expect(stored).toMatchObject({
    issuer: firstWorkspaceIdp.issuer,
    clientId: 'spyria-umbrella',
    domain: 'umbrella.com',
    verifiedAt: null,
  })
  expect(await createSecretBox(secretsKey).open(stored?.encryptedClientSecret ?? '')).toBe('umbrella-secret')
  expect([...(await emptyInstance.database.$client`select subject, user_id as "userId" from identities`)]).toEqual([
    { subject: winner === carol ? 'carol-subject' : 'dave-subject', userId },
  ])

  expect(await (await emptyInstanceApp.request('/auth/mode')).json()).toEqual({
    authMode: 'sso',
    canCreateWorkspace: false,
  })
  expect(await (await startCreation(umbrellaForm())).text()).toContain(
    '"status":"refused","message":"Workspace creation is closed on this instance: sign in with your work email"',
  )
  const winnerSubject = winner === carol ? 'carol-subject' : 'dave-subject'
  const adminBack = await signInThrough(
    firstWorkspaceIdp,
    `email=${member?.email}`,
    { sub: winnerSubject, email: member?.email },
    emptyInstanceApp,
  )
  expect(adminBack.page).toContain('"status":"signed_in"')
  expect(adminBack).toMatchObject({ userId, sessions: [{ workspaceId }] })
  const erin = await signInThrough(
    firstWorkspaceIdp,
    'email=erin@umbrella.com',
    { sub: 'erin-subject', email: 'erin@umbrella.com' },
    emptyInstanceApp,
  )
  expect(erin.status).toBe(403)
  expect(erin.page).toContain('"status":"not_invited","email":"erin@umbrella.com"')
  expect(await countsOf()).toEqual({ workspaces: 1, users: 1 })
  expect((await emptyInstanceApp.request('/auth/login?email=pat@other.com')).status).toBe(404)
  await emptyInstance.database.$client`
    insert into workspaces (workspace_id, name, created_by, created_at) values ('second', 'Second', ${userId}, now())`
  expect((await emptyInstanceApp.request('/auth/login?email=erin@umbrella.com')).status).toBe(404)
  await verifyDomainByOperator(emptyInstance.database, workspaceId, 'umbrella.com')
  expect((await emptyInstanceApp.request('/auth/login?email=erin@umbrella.com')).status).toBe(302)
})
