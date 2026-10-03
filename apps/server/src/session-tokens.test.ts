import { expect, test } from 'bun:test'
import type { ZeroContext } from '@hq/db/zero-queries'
import { memberId, workspaceId } from '@hq/kernel'
import { SignJWT, UnsecuredJWT } from 'jose'
import { createSessionTokens } from './session-tokens.ts'

const secret = 'unit-test-secret'
const aliceInAcme: ZeroContext = {
  userId: memberId('member-alice'),
  workspaceId: workspaceId('workspace-acme'),
  role: 'admin',
}
const sessionTokens = createSessionTokens(secret, async (workspaceId, userId) =>
  workspaceId === aliceInAcme.workspaceId && userId === aliceInAcme.userId ? 'admin' : undefined,
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

test('accepts an issued token and builds the context from the membership', async () => {
  expect(await sessionTokens.authenticate(bearer(await sessionTokens.issue(aliceInAcme)))).toEqual({
    status: 200,
    context: aliceInAcme,
  })
})

test('accepts a token expired within the 5 second clock tolerance', async () => {
  expect(
    (await sessionTokens.authenticate(bearer(await signed(aliceInAcme.workspaceId, nowInSeconds() - 3)))).status,
  ).toBe(200)
})

test('refuses a token expired beyond the clock tolerance', async () => {
  expect(await sessionTokens.authenticate(bearer(await signed(aliceInAcme.workspaceId, nowInSeconds() - 10)))).toEqual({
    status: 401,
  })
})

test('refuses a token signed with another secret', async () => {
  const forged = await signed(aliceInAcme.workspaceId, nowInSeconds() + 60, 'another-secret')
  expect(await sessionTokens.authenticate(bearer(forged))).toEqual({ status: 401 })
})

test('refuses a token whose payload was tampered with', async () => {
  const [header, , signature] = (await sessionTokens.issue(aliceInAcme)).split('.')
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...claimsOf('workspace-globex'), sub: aliceInAcme.userId, exp: nowInSeconds() + 60 }),
  ).toString('base64url')
  expect(await sessionTokens.authenticate(bearer(`${header}.${tamperedPayload}.${signature}`))).toEqual({ status: 401 })
})

test('refuses an unsigned token with alg none', async () => {
  const unsigned = new UnsecuredJWT(claimsOf(aliceInAcme.workspaceId))
    .setSubject(aliceInAcme.userId)
    .setExpirationTime(nowInSeconds() + 60)
    .encode()
  expect(await sessionTokens.authenticate(bearer(unsigned))).toEqual({ status: 401 })
})

test.each([undefined, '', 'Bearer', 'Basic abc', 'Bearer not-a-jwt'])(
  'refuses the authorization header %p',
  async (header) => {
    expect(await sessionTokens.authenticate(header)).toEqual({ status: 401 })
  },
)

test('refuses with 403 a valid token for a workspace without membership', async () => {
  const globexToken = await sessionTokens.issue({ ...aliceInAcme, workspaceId: workspaceId('workspace-globex') })
  expect(await sessionTokens.authenticate(bearer(globexToken))).toEqual({ status: 403 })
})
