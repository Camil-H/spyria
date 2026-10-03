import type { ZeroContext } from '@hq/db/zero-queries'
import { type MemberId, memberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import { jwtVerify, SignJWT } from 'jose'

export type FindMembershipRole = (
  workspaceId: WorkspaceId,
  userId: MemberId,
) => Promise<ZeroContext['role'] | undefined>

type Authentication = { status: 200; context: ZeroContext } | { status: 401 | 403 }

const algorithm = 'HS256'
const lifetimeSeconds = 15 * 60
const clockToleranceSeconds = 5

export const createSessionTokens = (secret: string, findMembershipRole: FindMembershipRole) => {
  const key = new TextEncoder().encode(secret)
  const readClaims = (token: string) =>
    jwtVerify(token, key, {
      algorithms: [algorithm],
      clockTolerance: clockToleranceSeconds,
      requiredClaims: ['sub', 'exp', 'sid'],
    }).then(
      ({ payload }) => payload,
      () => undefined,
    )
  return {
    issue: (context: ZeroContext) =>
      new SignJWT({ workspaceId: context.workspaceId, role: context.role, sid: crypto.randomUUID() })
        .setProtectedHeader({ alg: algorithm })
        .setSubject(context.userId)
        .setIssuedAt()
        .setExpirationTime(`${lifetimeSeconds}s`)
        .sign(key),
    authenticate: async (authorization: string | undefined): Promise<Authentication> => {
      const token = authorization?.match(/^Bearer (\S+)$/)?.[1]
      const claims = token === undefined ? undefined : await readClaims(token)
      if (claims?.sub === undefined || typeof claims.workspaceId !== 'string') return { status: 401 }
      const context = { userId: memberId(claims.sub), workspaceId: workspaceId(claims.workspaceId) }
      const role = await findMembershipRole(context.workspaceId, context.userId)
      return role === undefined ? { status: 403 } : { status: 200, context: { ...context, role } }
    },
  }
}
