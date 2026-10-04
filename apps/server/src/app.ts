import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { queries, type ZeroContext } from '@hq/db/zero-queries'
import { memberId, workspaceId } from '@hq/kernel'
import { workspaceMutators } from '@hq/workspace/server'
import { mustGetMutator, mustGetQuery } from '@rocicorp/zero'
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { Hono } from 'hono'
import { createSessionTokens, type FindMembershipRole } from './session-tokens.ts'

const errorByStatus = { 401: 'unauthorized', 403: 'forbidden' } as const

export const createApp = ({
  database,
  tokenSecret,
  isDevAuthEnabled,
  databaseByName,
}: {
  database: Database
  tokenSecret: string
  isDevAuthEnabled: boolean
  databaseByName?: (databaseName: string) => Database
}) => {
  const databaseOf = (databaseName: string | undefined) =>
    databaseName === undefined ? database : isDevAuthEnabled ? databaseByName?.(databaseName) : undefined
  const findMembershipRole: FindMembershipRole = async (workspaceId, userId, databaseName) =>
    (await databaseOf(databaseName)?.query.memberships.findFirst({ where: { workspaceId, userId } }))?.role
  const sessionTokens = createSessionTokens(tokenSecret, findMembershipRole)
  const app = new Hono<{ Variables: { zeroContext: ZeroContext; database: Database } }>()
    .get('/health', (context) => context.json({ status: 'ok' }))
    .use('/api/*', async (context, next) => {
      const authentication = await sessionTokens.authenticate(context.req.header('authorization'))
      if (authentication.status !== 200)
        return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
      context.set('zeroContext', authentication.context)
      context.set('database', databaseOf(authentication.databaseName) ?? database)
      await next()
    })
    .post('/api/query', async (context) => {
      const ctx = context.get('zeroContext')
      return context.json(
        await handleQueryRequest({
          handler: (name, args) => mustGetQuery(queries, name).fn({ args, ctx }),
          schema,
          request: context.req.raw,
          userID: ctx.userId,
        }),
      )
    })
    .post('/api/mutate', async (context) => {
      const ctx = context.get('zeroContext')
      return context.json(
        await handleMutateRequest({
          dbProvider: zeroDrizzle(schema, context.get('database')),
          handler: (transact) =>
            transact((tx, name, args) => mustGetMutator(workspaceMutators, name).fn({ args, tx, ctx })),
          request: context.req.raw,
          userID: ctx.userId,
        }),
      )
    })
  if (isDevAuthEnabled)
    app.post('/auth/dev-token', async (context) => {
      const body = await context.req.json().catch(() => null)
      if (typeof body?.workspaceId !== 'string' || typeof body?.userId !== 'string')
        return context.json({ error: 'workspaceId and userId are required' }, 400)
      const member = { workspaceId: workspaceId(body.workspaceId), userId: memberId(body.userId) }
      const databaseName = typeof body.db === 'string' ? body.db : undefined
      const role = await findMembershipRole(member.workspaceId, member.userId, databaseName)
      if (role === undefined) return context.json({ error: errorByStatus[403] }, 403)
      return context.json({ token: await sessionTokens.issue({ ...member, role }, databaseName), role })
    })
  return app
}
