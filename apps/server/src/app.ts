import { commandOutputPathOf, conversationMutators, readCommandOutput } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { queries, type ZeroContext } from '@hq/db/zero-queries'
import type { RuntimeHostId } from '@hq/kernel'
import {
  addLlmCredentialFromRequest,
  type createLlmGateway,
  llmCredentialsPath,
  ProfileError,
  profileMutators,
} from '@hq/profile/server'
import {
  addRuntimeHostFromRequest,
  RuntimeError,
  renewClaimCodeFromRequest,
  runtimeHostsPath,
  runtimeMutators,
} from '@hq/runtime/server'
import { workspaceMutators } from '@hq/workspace/server'
import { getMutator, mustGetMutator, mustGetQuery, type Transaction } from '@rocicorp/zero'
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { Hono } from 'hono'
import { type AgentBridge, createAgentBridge } from './agent-bridge/bridge.ts'
import { createOidc, type OidcSettings } from './auth/oidc.ts'
import { createAuthRoutes } from './auth/routes.ts'
import { createSessionAuthenticator, errorByStatus } from './auth/session-tokens.ts'
import { findMemberIn } from './auth/sessions.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway, type RuntimeHostGateway } from './runtime-hosts/gateway.ts'

export const defaultLlm = { model: 'openai/fake/fake-model' }
type LlmGateway = ReturnType<typeof createLlmGateway>

const statusByRuntimeErrorCode: Record<string, number> = { not_admin: 403, host_not_found: 404 }

type ZeroDatabase = ReturnType<typeof zeroDrizzle<typeof schema, Database>>

const runtimeHostResponse = async (
  zeroDatabase: ZeroDatabase,
  successStatus: number,
  endpoint: (tx: Transaction) => Promise<object>,
) => {
  try {
    return Response.json(await zeroDatabase.transaction(endpoint), { status: successStatus })
  } catch (error) {
    if (error instanceof RuntimeError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: statusByRuntimeErrorCode[error.code] ?? 400 },
      )
    console.error(`A runtime host request failed with ${error instanceof Error ? error.name : 'an unknown error'}`)
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}

export const createApp = ({
  database,
  tokenSecret,
  oidc,
  appOrigin,
  testDatabaseByName,
  llmGateway,
  runtimeHosts = createRuntimeHostGateway({
    databases: () => [database],
    relayModelCall:
      llmGateway &&
      createModelCallRelay({ gatewayUrlOf: () => llmGateway.url, llmGateway, agentBridge: () => agentBridge }),
  }),
  agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: defaultLlm }),
  fakeLlm,
}: {
  database: Database
  tokenSecret: string
  oidc: OidcSettings
  appOrigin: string
  testDatabaseByName?: (databaseName: string) => Database
  llmGateway?: LlmGateway
  runtimeHosts?: RuntimeHostGateway
  agentBridge?: AgentBridge
  fakeLlm?: Hono
}) => {
  const mutatorNamed = (name: string) =>
    getMutator(workspaceMutators, name) ??
    getMutator(profileMutators, name) ??
    getMutator(runtimeMutators, name) ??
    mustGetMutator(conversationMutators, name)
  const databaseOf = (databaseName: string | undefined) =>
    databaseName === undefined ? database : testDatabaseByName?.(databaseName)
  const authenticate = createSessionAuthenticator(tokenSecret, findMemberIn(databaseOf))
  const app = new Hono<{
    Variables: { zeroContext: ZeroContext; zeroDatabase: ZeroDatabase }
  }>()
    .get('/health', (context) => context.json({ status: 'ok' }))
    .get('/host', runtimeHosts.upgrade)
    .get('/api/stream', agentBridge.stream(authenticate, databaseOf))
    .route(
      '/auth',
      createAuthRoutes({ oidc: createOidc(oidc), tokenSecret, appOrigin, database, authenticate, testDatabaseByName }),
    )
    .use('/api/*', async (context, next) => {
      const authentication = await authenticate(context.req.header('authorization'))
      if (authentication.status !== 200)
        return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
      context.set('zeroContext', authentication.context)
      context.set('zeroDatabase', zeroDrizzle(schema, databaseOf(authentication.databaseName) ?? database))
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
          dbProvider: context.get('zeroDatabase'),
          handler: async (transact, mutation) => {
            const response = await transact((tx, name, args) => mutatorNamed(name).fn({ args, tx, ctx }))
            if (mutation.name === 'runtime.removeHost' && !('error' in response.result))
              runtimeHosts.disconnect(ctx.workspaceId, (mutation.args[0] as { hostId: RuntimeHostId }).hostId)
            return response
          },
          request: context.req.raw,
          userID: ctx.userId,
        }),
      )
    })
    .get(commandOutputPathOf(':chatId', ':stepId'), async (context) => {
      const [chatId = '', stepId = ''] = [context.req.param('chatId'), context.req.param('stepId')]
      return context.text(
        await context
          .get('zeroDatabase')
          .transaction((tx) => readCommandOutput(tx, context.get('zeroContext'), chatId, stepId)),
      )
    })
    .post(llmCredentialsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      try {
        if (!llmGateway) throw new Error('No LLM gateway is configured')
        await addLlmCredentialFromRequest(
          (work) => context.get('zeroDatabase').transaction(work),
          context.get('zeroContext'),
          body,
          llmGateway,
        )
      } catch (error) {
        if (error instanceof ProfileError) return context.json({ error: error.code, message: error.message }, 400)
        console.error(
          `Adding an LLM credential failed with ${error instanceof Error ? error.name : 'an unknown error'}`,
        )
        return context.json({ error: 'internal' }, 500)
      }
      return context.body(null, 201)
    })
    .post(runtimeHostsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return runtimeHostResponse(context.get('zeroDatabase'), 201, (tx) =>
        addRuntimeHostFromRequest(tx, context.get('zeroContext'), body),
      )
    })
    .post(`${runtimeHostsPath}/:hostId/code`, (context) =>
      runtimeHostResponse(context.get('zeroDatabase'), 200, (tx) =>
        renewClaimCodeFromRequest(tx, context.get('zeroContext'), context.req.param('hostId')),
      ),
    )
  if (fakeLlm) app.route('/fake-llm', fakeLlm)
  return app
}
