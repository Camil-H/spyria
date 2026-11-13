import { afterAll, expect, test } from 'bun:test'
import { workspacePermissions } from '@spyria/kernel'
import type { JWTPayload } from 'jose'
import { createApp } from '../app.ts'
import { rateBudgets } from '../rate-limits.ts'
import { type FakeIdp, startFakeIdp } from '../testing/fake-idp.ts'
import { openSharedTestApp, requestMutationWith, testAuthSettings, workspaceEventsOf } from '../testing/testing.ts'
import { createSecretBox, secretsKeyringOf } from './secret-box.ts'
import { issueSessionToken } from './session-tokens.ts'
import { openSessions } from './sessions.ts'
import { confirmSsoSettings } from './sso.ts'

const { database } = await openSharedTestApp()
const secretsKeyring = secretsKeyringOf('domain-claims-integration-secrets-key-0123')
const txtRecordsByDomain = new Map<string, string[][]>()
const accountIdp = await startFakeIdp()
const umbrellaIdp = await startFakeIdp()
const tyrellIdp = await startFakeIdp()
accountIdp.clientSecrets['spyria-accounts'] = 'accounts-secret'
const app = createApp({
  database,
  ...testAuthSettings,
  authMode: 'sso',
  secretsKeyring,
  instanceSignInApps: {
    oidc: { issuer: accountIdp.issuer, clientId: 'spyria-accounts', clientSecret: 'accounts-secret' },
  },
  resolveTxt: async (domain) => txtRecordsByDomain.get(domain) ?? [],
})
afterAll(async () => {
  for (const idp of [accountIdp, umbrellaIdp, tyrellIdp]) await idp.server.stop(true)
})

const ana = 'member-ana'
const ben = 'member-ben'
const carl = 'member-carl'
const dee = 'member-dee'
await database.$client`
  insert into users (id, email) values (${ana}, 'ana@umbrella.com'), (${ben}, 'ben@umbrella.com'),
    (${carl}, 'carl@gmail.com'), (${dee}, 'dee@tyrell.com')`

const addWorkspace = async (workspaceId: string, adminId: string, memberIds: string[] = []) => {
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
  for (const memberId of memberIds)
    await database.$client`
      insert into memberships (workspace_id, user_id, role, display_name)
      values (${workspaceId}, ${memberId}, 'member', ${memberId})`
}
const enforceSso = async (workspaceId: string, idp: FakeIdp) => {
  const clientId = `spyria-${workspaceId}`
  idp.clientSecrets[clientId] = `${workspaceId}-secret`
  const encryptedClientSecret = await createSecretBox(secretsKeyring).seal(`${workspaceId}-secret`)
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${workspaceId}, 'oidc', ${idp.issuer}, ${clientId}, ${encryptedClientSecret}, now())`
}

await addWorkspace('umbrella', ana, [carl])
await enforceSso('umbrella', umbrellaIdp)
await addWorkspace('side', ben, [carl])
await addWorkspace('tyrell', dee, [ben])
await enforceSso('tyrell', tyrellIdp)

const tokenThrough = async (workspaceId: string, userId: string, providerWorkspaceId: string | null) => {
  const [session] = await openSessions(database, userId, workspaceId, providerWorkspaceId)
  if (!session) throw new Error(`${userId} has no session in ${workspaceId} through ${providerWorkspaceId}`)
  return (await issueSessionToken(testAuthSettings.tokenSecret, session)).token
}
const requestAs = async (token: string, path: string, body?: object) => {
  const response = await app.request(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as {
      claims?: { domain: string; record: string; isVerified: boolean }[]
      isOpen?: boolean
      error?: string
      message?: string
    },
  }
}
const claimAs = async (workspaceId: string, userId: string, action: '' | '/verify' | '/release', domain: string) =>
  requestAs(await tokenThrough(workspaceId, userId, workspaceId), `/api/domain-claims${action}`, { domain })
const sessionRowsOf = async (...userIds: string[]) => [
  ...(await database.$client`
    select distinct workspace_id as "workspaceId", user_id as "userId", provider_workspace_id as "providerWorkspaceId"
    from sessions where user_id in ${database.$client(userIds)} order by workspace_id, user_id`),
]
const claimsOf = async (workspaceId: string) => [
  ...(await database.$client`
    select domain, verified_at is not null as "isVerified" from domain_claims
    where workspace_id = ${workspaceId} order by domain`),
]
const claimAndVerify = async (workspaceId: string, userId: string, domain: string) => {
  const record = (await claimAs(workspaceId, userId, '', domain)).body.claims?.find(
    (claim) => claim.domain === domain,
  )?.record
  txtRecordsByDomain.set(domain, [[record ?? '']])
  return claimAs(workspaceId, userId, '/verify', domain)
}

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')
let codeCount = 0
const signInThrough = async (idp: FakeIdp, loginQuery: string, claims: JWTPayload, cookie = '') => {
  const started = await app.request(`/auth/login?${loginQuery}`, { headers: { cookie } })
  const location = new URL(started.headers.get('location') ?? 'http://nowhere.invalid')
  if (location.origin !== idp.origin) return { status: started.status, page: await started.text(), workspaceIds: [] }
  const code = `code-${++codeCount}`
  idp.claimsByCode.set(code, { nonce: location.searchParams.get('nonce') ?? '', ...claims })
  const response = await app.request(`/auth/callback?code=${code}&state=${location.searchParams.get('state')}`, {
    headers: { cookie: cookieHeaderOf(started) },
  })
  const { sessions } = (await (
    await app.request('/auth/sessions', { headers: { cookie: cookieHeaderOf(response) } })
  ).json()) as { sessions: { workspaceId: string }[] }
  return {
    status: response.status,
    page: await response.text(),
    workspaceIds: sessions.map(({ workspaceId }) => workspaceId).toSorted(),
  }
}
const providersOf = async (email: string) =>
  ((await (await app.request(`/auth/providers?email=${encodeURIComponent(email)}`)).json()) as { providers: unknown[] })
    .providers
const accountProvider = { id: 'oidc', kind: 'oidc', isWorkspaceSso: false }
const inviteAs = async (workspaceId: string, userId: string, email: string) =>
  requestMutationWith(app, await tokenThrough(workspaceId, userId, 'umbrella'), 'workspace.inviteMember', {
    workspaceId,
    id: crypto.randomUUID(),
    email,
    role: 'member',
  })
const refusal = (message: string) =>
  expect.objectContaining({ error: 'app', message: expect.stringContaining(message) })

test('an Admin claims a domain by a DNS TXT record: the claim waits until Spyria finds the record, then holds and ends the sessions it no longer trusts', async () => {
  const benAccountToken = await tokenThrough('side', ben, null)
  const carlUmbrellaToken = await tokenThrough('umbrella', carl, 'umbrella')
  const claimed = await claimAs('umbrella', ana, '', ' @Umbrella.COM ')
  const record = claimed.body.claims?.[0]?.record ?? ''
  expect(record).toMatch(/^spyria-verify=[0-9a-f]{32}$/)
  expect(claimed).toEqual({
    status: 200,
    body: { claims: [{ domain: 'umbrella.com', record, isVerified: false }] },
  })
  expect((await claimAs('umbrella', ana, '/verify', 'umbrella.com')).body).toMatchObject({
    error: 'verification_record_not_found',
  })
  txtRecordsByDomain.set('umbrella.com', [['spyria-verify=someone-else'], ['v=spf1 -all']])
  expect((await claimAs('umbrella', ana, '/verify', 'umbrella.com')).body.error).toBe('verification_record_not_found')
  expect(await claimsOf('umbrella')).toEqual([{ domain: 'umbrella.com', isVerified: false }])
  txtRecordsByDomain.set('umbrella.com', [['v=spf1 -all'], [record.slice(0, 20), record.slice(20)]])
  expect(await claimAs('umbrella', ana, '/verify', 'umbrella.com')).toEqual({
    status: 200,
    body: { claims: [{ domain: 'umbrella.com', record, isVerified: true }] },
  })
  expect((await workspaceEventsOf(database, 'umbrella')).filter(({ type }) => type.startsWith('domain.'))).toEqual([
    { type: 'domain.claimed', actorId: ana, payload: { domain: 'umbrella.com' } },
  ])
  for (const ended of [benAccountToken, carlUmbrellaToken])
    expect((await requestAs(ended, '/api/workspace-creation')).status).toBe(401)
  expect(await sessionRowsOf(ben, carl)).toEqual([])
})

test('claiming is refused without Setup SSO, to a workspace without its own provider, for what is not a domain, and for a domain another workspace holds', async () => {
  expect(await requestAs(await tokenThrough('tyrell', ben, 'tyrell'), '/api/domain-claims')).toMatchObject({
    status: 403,
    body: { error: 'missing_workspace_permission' },
  })
  expect(
    (await requestAs(await tokenThrough('side', ben, 'umbrella'), '/api/domain-claims', { domain: 'side.com' })).body,
  ).toMatchObject({ error: 'claim_needs_sso' })
  expect((await claimAs('tyrell', dee, '', 'localhost')).body).toMatchObject({ error: 'invalid_domain' })
  expect((await claimAs('tyrell', dee, '', 'umbrella.com')).body).toMatchObject({
    error: 'domain_claimed_elsewhere',
    message: 'umbrella.com belongs to another workspace of this Spyria: its addresses can join only that one',
  })
  expect(await claimsOf('tyrell')).toEqual([])
})

test('of two workspaces waiting for the same domain, only the first whose record is found gets it', async () => {
  const tyrellRecord = (await claimAs('tyrell', dee, '', 'tyrell.com')).body.claims?.[0]?.record ?? ''
  const umbrellaRecord =
    (await claimAs('umbrella', ana, '', 'tyrell.com')).body.claims?.find(({ domain }) => domain === 'tyrell.com')
      ?.record ?? ''
  txtRecordsByDomain.set('tyrell.com', [[tyrellRecord], [umbrellaRecord]])
  expect((await claimAs('tyrell', dee, '/verify', 'tyrell.com')).status).toBe(200)
  expect((await claimAs('umbrella', ana, '/verify', 'tyrell.com')).body).toMatchObject({
    error: 'domain_claimed_elsewhere',
  })
  expect((await claimAs('umbrella', ana, '/release', 'tyrell.com')).status).toBe(200)
  expect((await claimAs('tyrell', dee, '/release', 'tyrell.com')).status).toBe(200)
  expect([...(await claimsOf('umbrella')), ...(await claimsOf('tyrell'))]).toEqual([
    { domain: 'umbrella.com', isVerified: true },
  ])
})

test('an address at a claimed domain is offered only the providers of its workspaces, the claiming one first, and its own account is refused', async () => {
  expect(await providersOf('ben@umbrella.com')).toEqual([
    { id: 'workspace-0', kind: 'oidc', isWorkspaceSso: true },
    { id: 'workspace-1', kind: 'oidc', isWorkspaceSso: true },
  ])
  expect(await providersOf('new@umbrella.com')).toEqual([{ id: 'workspace-0', kind: 'oidc', isWorkspaceSso: true }])
  expect(await providersOf('carl@gmail.com')).toEqual([
    accountProvider,
    { id: 'workspace-0', kind: 'oidc', isWorkspaceSso: true },
  ])
  const throughAccount = await signInThrough(accountIdp, 'provider=oidc&email=ben@umbrella.com', {
    sub: 'ben-account',
    email: 'ben@umbrella.com',
  })
  expect(throughAccount.status).toBe(403)
  expect(throughAccount.page).toContain("ben@umbrella.com signs in through your organization's provider")
  expect(throughAccount.workspaceIds).toEqual([])
})

test("through the claiming workspace's provider, an address at its domain opens every workspace it belongs to, except one enforcing a provider of its own", async () => {
  const throughUmbrella = await signInThrough(umbrellaIdp, 'provider=workspace-0&email=ben@umbrella.com', {
    sub: 'ben-umbrella',
    email: 'ben@umbrella.com',
  })
  expect(throughUmbrella.workspaceIds).toEqual(['side'])
  const throughTyrell = await signInThrough(tyrellIdp, 'provider=workspace-1&email=ben@umbrella.com', {
    sub: 'ben-tyrell',
    email: 'ben@umbrella.com',
  })
  expect(throughTyrell.workspaceIds).toEqual(['tyrell'])
  const sideToken = await tokenThrough('side', ben, 'umbrella')
  expect((await requestAs(sideToken, '/api/workspace-creation')).body).toEqual({ isOpen: false })
  expect(await openSessions(database, ben, 'tyrell', 'umbrella')).toHaveLength(0)
})

test('signing in to a workspace without its own SSO, from a browser signed in at a claimed domain, goes to the claiming provider', async () => {
  const [session] = await openSessions(database, ben, 'side', 'umbrella')
  const started = await app.request('/auth/login?workspace=side', {
    headers: { cookie: `spyria_s_side=${session?.sessionId}` },
  })
  const location = new URL(started.headers.get('location') ?? '')
  expect(location.origin).toBe(umbrellaIdp.origin)
  expect(location.searchParams.get('login_hint')).toBe('ben@umbrella.com')
})

test("once its workspace claimed a domain, the workspace's provider refuses addresses elsewhere, members included", async () => {
  const outside = await signInThrough(umbrellaIdp, 'workspace=umbrella', {
    sub: 'carl-umbrella',
    email: 'carl@gmail.com',
  })
  expect(outside.status).toBe(403)
  expect(outside.page).toContain(
    'This workspace signs in only addresses at its own domains, and carl@gmail.com is not one of them',
  )
  expect(outside.workspaceIds).toEqual([])
  expect(await openSessions(database, carl, 'umbrella', 'umbrella')).toHaveLength(0)
  const throughAccount = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'carl-account',
    email: 'carl@gmail.com',
  })
  expect(throughAccount.workspaceIds).toEqual(['side'])
  const carlToken = await tokenThrough('side', carl, null)
  expect((await requestAs(carlToken, '/api/workspace-creation')).body).toEqual({ isOpen: true })
})

test('creating a workspace is refused to an address at a claimed domain and to a session of a provider that claimed none', async () => {
  const createdBy = async (workspaceId: string, providerWorkspaceId: string, id: string) =>
    requestMutationWith(app, await tokenThrough(workspaceId, ben, providerWorkspaceId), 'workspace.createWorkspace', {
      workspaceId,
      id,
      name: id,
    })
  expect(await createdBy('side', 'umbrella', 'ben-side-project')).toEqual(
    refusal("Your address belongs to your organization's workspace: it cannot create another one"),
  )
  expect(await createdBy('tyrell', 'tyrell', 'ben-tyrell-project')).toEqual(
    refusal("Your organization's sign-in opens only its workspace"),
  )
  expect(await database.$client`select 1 from workspaces where workspace_id like 'ben-%'`).toHaveLength(0)
})

test('invites refuse an address at a domain another workspace claimed, and in a claiming workspace an address outside its domains', async () => {
  expect(await inviteAs('side', ben, 'new@umbrella.com')).toEqual(
    refusal('umbrella.com belongs to another workspace of this Spyria'),
  )
  expect(await inviteAs('umbrella', ana, 'pat@gmail.com')).toEqual(
    refusal('This workspace signs in only addresses at its own domains, and pat@gmail.com is not one of them'),
  )
  expect(await inviteAs('umbrella', ana, 'new@umbrella.com')).toEqual({})
  expect(await inviteAs('side', ben, 'pat@gmail.com')).toEqual({})
  expect([
    ...(await database.$client`select workspace_id, email from invitations where workspace_id in ('side', 'umbrella')
      order by workspace_id, email`),
  ]).toEqual([
    { workspace_id: 'side', email: 'pat@gmail.com' },
    { workspace_id: 'umbrella', email: 'new@umbrella.com' },
  ])
})

test("an Admin's change of claims is refused when their own address would end up outside the workspace's domains", async () => {
  await addWorkspace('acme-sub', ana)
  await enforceSso('acme-sub', umbrellaIdp)
  expect((await claimAndVerify('acme-sub', ana, 'umbrella.fr')).body).toMatchObject({
    error: 'claim_would_lock_you_out',
    message:
      "Your own address is at umbrella.com, which would be outside this workspace's domains: you could no longer sign in",
  })
  expect((await claimAndVerify('umbrella', ana, 'umbrella.fr')).status).toBe(200)
  expect((await claimAs('umbrella', ana, '/release', 'umbrella.com')).body).toMatchObject({
    error: 'claim_would_lock_you_out',
  })
  expect((await claimAs('umbrella', ana, '/release', 'umbrella.fr')).status).toBe(200)
  expect(await claimsOf('umbrella')).toEqual([{ domain: 'umbrella.com', isVerified: true }])
})

test('releasing a claim frees the domain at once: the sessions its provider opened elsewhere end and own accounts sign in again', async () => {
  const sideToken = await tokenThrough('side', ben, 'umbrella')
  const released = await claimAs('umbrella', ana, '/release', 'umbrella.com')
  expect(released.body).toEqual({ claims: [] })
  expect((await requestAs(sideToken, '/api/workspace-creation')).status).toBe(401)
  expect((await workspaceEventsOf(database, 'umbrella')).filter(({ type }) => type === 'domain.released')).toEqual([
    { type: 'domain.released', actorId: ana, payload: { domain: 'umbrella.fr' } },
    { type: 'domain.released', actorId: ana, payload: { domain: 'umbrella.com' } },
  ])
  expect(await sessionRowsOf(ben)).not.toContainEqual(expect.objectContaining({ providerWorkspaceId: 'umbrella' }))
  const throughAccount = await signInThrough(accountIdp, 'provider=oidc', {
    sub: 'ben-account',
    email: 'ben@umbrella.com',
  })
  expect(throughAccount.workspaceIds).toEqual(['side'])
  expect((await claimAndVerify('umbrella', ana, 'umbrella.com')).status).toBe(200)
  expect((await requestAs(sideToken, '/api/workspace-creation')).status).toBe(401)
  expect(await sessionRowsOf(ben)).toEqual([{ workspaceId: 'tyrell', userId: ben, providerWorkspaceId: 'tyrell' }])
})

test('a new issuer for the claiming workspace ends the sessions its former provider opened in other workspaces', async () => {
  const sideToken = await tokenThrough('side', ben, 'umbrella')
  const encryptedClientSecret = await createSecretBox(secretsKeyring).seal('new-umbrella-secret')
  await confirmSsoSettings(
    database,
    {
      workspaceId: 'umbrella',
      userId: ana,
      email: 'ana@umbrella.com',
      provider: {
        preset: 'oidc',
        issuer: `${umbrellaIdp.issuer}/new`,
        clientId: 'spyria-umbrella',
        encryptedClientSecret,
        usesInstanceApp: false,
      },
    },
    { email: 'ana@umbrella.com', issuer: `${umbrellaIdp.issuer}/new`, subject: 'ana-new', canBindByEmail: true },
  )
  expect((await requestAs(sideToken, '/api/workspace-creation')).status).toBe(401)
  expect(await sessionRowsOf(ben)).toEqual([{ workspaceId: 'tyrell', userId: ben, providerWorkspaceId: 'tyrell' }])
  expect(await claimsOf('umbrella')).toEqual([{ domain: 'umbrella.com', isVerified: true }])
})

test("stopping a workspace's SSO and deleting the workspace release its claims and end the sessions their providers opened", async () => {
  const sideToken = await tokenThrough('side', ben, 'umbrella')
  const stopped = await requestAs(await tokenThrough('umbrella', ana, 'umbrella'), '/api/sso-settings/stop', {})
  expect(stopped.status).toBe(204)
  expect(await claimsOf('umbrella')).toEqual([])
  expect((await requestAs(sideToken, '/api/workspace-creation')).status).toBe(401)
  expect(await sessionRowsOf(ben)).toEqual([{ workspaceId: 'tyrell', userId: ben, providerWorkspaceId: 'tyrell' }])
  const events = await workspaceEventsOf(database, 'umbrella')
  expect(events.filter(({ payload }) => payload.domain === 'umbrella.com').map(({ type }) => type)).toEqual([
    'domain.claimed',
    'domain.released',
    'domain.claimed',
    'domain.released',
  ])
  expect(events.filter(({ type }) => type === 'sso.removed')).toEqual([
    { type: 'sso.removed', actorId: ana, payload: {} },
  ])
  expect((await claimAndVerify('tyrell', dee, 'tyrell.com')).status).toBe(200)
  expect(
    await requestMutationWith(app, await tokenThrough('tyrell', dee, 'tyrell'), 'workspace.deleteWorkspace', {
      workspaceId: 'tyrell',
      confirmation: 'DELETE',
    }),
  ).toEqual({})
  expect(await claimsOf('tyrell')).toEqual([])
})

test('claiming and checking domains answer 429 past their budget per address', async () => {
  const limitedApp = createApp({
    database,
    ...testAuthSettings,
    authMode: 'sso',
    secretsKeyring,
    rateLimits: rateBudgets,
    resolveTxt: async () => [],
  })
  const token = await tokenThrough('acme-sub', ana, 'acme-sub')
  const check = () =>
    limitedApp.request('/api/domain-claims/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'umbrella.fr' }),
    })
  for (let sent = 0; sent < rateBudgets.domainClaims.count; sent++) expect((await check()).status).toBe(400)
  expect((await check()).status).toBe(429)
})
