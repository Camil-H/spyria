import { conversationMutators } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { queries, type ZeroContext } from '@hq/db/zero-queries'
import { addLlmCredentialFromRequest, llmCredentialsPath, ProfileError, profileMutators } from '@hq/profile/server'
import { workspaceMutators } from '@hq/workspace/server'
import { getMutator, mustGetMutator, mustGetQuery } from '@rocicorp/zero'
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { Hono } from 'hono'
import { createOidc, type OidcSettings } from './auth/oidc.ts'
import { createAuthRoutes } from './auth/routes.ts'
import { createSessionAuthenticator } from './auth/session-tokens.ts'
import { findMemberIn } from './auth/sessions.ts'

const errorByStatus = { 401: 'unauthorized', 403: 'forbidden' } as const
const mutatorNamed = (name: string) =>
  getMutator(workspaceMutators, name) ?? getMutator(profileMutators, name) ?? mustGetMutator(conversationMutators, name)

export const createApp = ({
  database,
  tokenSecret,
  oidc,
  appOrigin,
  testDatabaseByName,
}: {
  database: Database
  tokenSecret: string
  oidc: OidcSettings
  appOrigin: string
  testDatabaseByName?: (databaseName: string) => Database
}) => {
  const databaseOf = (databaseName: string | undefined) =>
    databaseName === undefined ? database : testDatabaseByName?.(databaseName)
  const authenticate = createSessionAuthenticator(tokenSecret, findMemberIn(databaseOf))
  return new Hono<{ Variables: { zeroContext: ZeroContext; database: Database } }>()
    .get('/health', (context) => context.json({ status: 'ok' }))
    .route(
      '/auth',
      createAuthRoutes({ oidc: createOidc(oidc), tokenSecret, appOrigin, database, authenticate, testDatabaseByName }),
    )
    .use('/api/*', async (context, next) => {
      const authentication = await authenticate(context.req.header('authorization'))
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
          handler: (transact) => transact((tx, name, args) => mutatorNamed(name).fn({ args, tx, ctx })),
          request: context.req.raw,
          userID: ctx.userId,
        }),
      )
    })
    .post(llmCredentialsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      const zeroDatabase = zeroDrizzle(schema, context.get('database'))
      try {
        await zeroDatabase.transaction((tx) => addLlmCredentialFromRequest(tx, context.get('zeroContext'), body))
      } catch (error) {
        if (error instanceof ProfileError) return context.json({ error: error.code, message: error.message }, 400)
        console.error(
          `Adding an LLM credential failed with ${error instanceof Error ? error.name : 'an unknown error'}`,
        )
        return context.json({ error: 'internal' }, 500)
      }
      return context.body(null, 201)
    })
}
