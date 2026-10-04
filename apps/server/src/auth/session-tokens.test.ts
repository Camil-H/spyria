import { expect, test } from 'bun:test'
import { SignJWT, UnsecuredJWT } from 'jose'
import { createSessionAuthenticator, issueSessionToken, type SessionClaims } from './session-tokens.ts'

const secret = 'unit-test-secret'
const aliceInAcme: SessionClaims = {
  userId: 'member-alice',
  workspaceId: 'workspace-acme',
  role: 'admin',
  sessionId: 'session-1',
}
const revokedSessionIds = new Set(['session-revoked'])
const authenticate = createSessionAuthenticator(secret, async ({ workspaceId, userId, sessionId }) =>
  workspaceId === aliceInAcme.workspaceId && userId === aliceInAcme.userId
    ? { role: 'admin', hasLiveSession: !revokedSessionIds.has(sessionId) }
    : undefined,
)
const nowInSeconds = () => Math.floor(Date.now() / 1000)
const claimsOf = (workspace: string) => ({ workspaceId: workspace, role: 'admin', sid: 'session-1' })
const signed = (workspace: string, expiresAt: number, signingSecret = secret) =>
  new SignJWT(claimsOf(workspace))
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(aliceInAcme.userId)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(signingSecret))
const bearer = (token: string) => `Bearer ${token}`
const issued = async (claims: SessionClaims) => (await issueSessionToken(secret, claims)).token

test('accepts an issued token and builds the context from the membership', async () => {
  expect(await authenticate(bearer(await issued(aliceInAcme)))).toMatchObject({
    status: 200,
    context: { userId: aliceInAcme.userId, workspaceId: aliceInAcme.workspaceId, role: 'admin' },
    sessionId: 'session-1',
  })
})

test('issues a token with its expiry for the client', async () => {
  const session = await issueSessionToken(secret, aliceInAcme, { lifetimeSeconds: 60 })
  expect(session).toMatchObject({ workspaceId: aliceInAcme.workspaceId, role: 'admin' })
  expect(session.expiresAt).toBeGreaterThan(Date.now() + 55_000)
  expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)
})

test('accepts a token expired within the 5 second clock tolerance', async () => {
  expect((await authenticate(bearer(await signed(aliceInAcme.workspaceId, nowInSeconds() - 3)))).status).toBe(200)
})

test('refuses a token expired beyond the clock tolerance', async () => {
  expect(await authenticate(bearer(await signed(aliceInAcme.workspaceId, nowInSeconds() - 10)))).toEqual({
    status: 401,
  })
})

test('refuses a token signed with another secret', async () => {
  const forged = await signed(aliceInAcme.workspaceId, nowInSeconds() + 60, 'another-secret')
  expect(await authenticate(bearer(forged))).toEqual({ status: 401 })
})

test('refuses a token whose payload was tampered with', async () => {
  const [header, , signature] = (await issued(aliceInAcme)).split('.')
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...claimsOf('workspace-globex'), sub: aliceInAcme.userId, exp: nowInSeconds() + 60 }),
  ).toString('base64url')
  expect(await authenticate(bearer(`${header}.${tamperedPayload}.${signature}`))).toEqual({ status: 401 })
})

test('refuses an unsigned token with alg none', async () => {
  const unsigned = new UnsecuredJWT(claimsOf(aliceInAcme.workspaceId))
    .setSubject(aliceInAcme.userId)
    .setExpirationTime(nowInSeconds() + 60)
    .encode()
  expect(await authenticate(bearer(unsigned))).toEqual({ status: 401 })
})

test.each([undefined, '', 'Bearer', 'Basic abc', 'Bearer not-a-jwt'])(
  'refuses the authorization header %p',
  async (header) => {
    expect(await authenticate(header)).toEqual({ status: 401 })
  },
)

test('refuses with 403 a valid token for a workspace without membership', async () => {
  expect(await authenticate(bearer(await issued({ ...aliceInAcme, workspaceId: 'workspace-globex' })))).toEqual({
    status: 403,
  })
})

test('refuses with 401 a valid token whose session was revoked', async () => {
  expect(await authenticate(bearer(await issued({ ...aliceInAcme, sessionId: 'session-revoked' })))).toEqual({
    status: 401,
  })
})
