import type { ZeroContext } from '@hq/db/zero-queries'
import { memberId, workspaceId } from '@hq/kernel'
import { jwtVerify, SignJWT } from 'jose'

export type SessionClaims = { workspaceId: string; userId: string; sessionId: string }
export type FindMember = (
  claims: SessionClaims,
  databaseName: string | undefined,
) => Promise<{ hasLiveSession: boolean } | undefined>
export type Authentication = { status: 200; context: ZeroContext; databaseName?: string } | { status: 401 | 403 }

export const errorByStatus = { 401: 'unauthorized', 403: 'forbidden' } as const

const algorithm = 'HS256'
const defaultLifetimeSeconds = 15 * 60
const clockToleranceSeconds = 5
const keyOf = (secret: string) => new TextEncoder().encode(secret)

export const issueSessionToken = async (
  secret: string,
  { workspaceId, userId, sessionId }: SessionClaims,
  { databaseName, lifetimeSeconds = defaultLifetimeSeconds }: { databaseName?: string; lifetimeSeconds?: number } = {},
) => {
  const expiresAt = Date.now() + lifetimeSeconds * 1000
  const token = await new SignJWT({ workspaceId, sid: sessionId, db: databaseName })
    .setProtectedHeader({ alg: algorithm })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(keyOf(secret))
  return { workspaceId, token, expiresAt }
}

export const createSessionAuthenticator =
  (secret: string, findMember: FindMember) =>
  async (authorization: string | undefined): Promise<Authentication> => {
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1]
    const claims = await jwtVerify(token ?? '', keyOf(secret), {
      algorithms: [algorithm],
      clockTolerance: clockToleranceSeconds,
      requiredClaims: ['sub', 'exp', 'sid'],
    }).then(
      ({ payload }) => payload,
      () => undefined,
    )
    if (claims?.sub === undefined || typeof claims.workspaceId !== 'string' || typeof claims.sid !== 'string')
      return { status: 401 }
    const context = { userId: memberId(claims.sub), workspaceId: workspaceId(claims.workspaceId) }
    const databaseName = typeof claims.db === 'string' ? claims.db : undefined
    const member = await findMember({ ...context, sessionId: claims.sid }, databaseName)
    if (member === undefined) return { status: 403 }
    if (!member.hasLiveSession) return { status: 401 }
    return { status: 200, context, databaseName }
  }
