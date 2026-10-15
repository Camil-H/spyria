import {
  type AgentChat,
  chatPlanModePathOf,
  chatQuestionPathOf,
  chatRoutingPathOf,
  commandOutputPathOf,
  conversationMutators,
  createGatewaySessionClassifier,
  planModeOf,
  questionAnswerOf,
  readChatRouting,
  readCommandOutput,
} from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { queries, type ZeroContext } from '@hq/db/zero-queries'
import { chatId, type RuntimeHostId } from '@hq/kernel'
import {
  addLlmCredentialFromRequest,
  availableToolsFromRequest,
  type createLlmGateway,
  createMemberKeyReader,
  llmCredentialsPath,
  ProfileError,
  profileMutators,
  toolConnectionFromRequest,
  toolConnectionsPath,
  toolConsentCallbackPath,
  toolConsentPageFromRequest,
} from '@hq/profile/server'
import {
  addRuntimeHostFromRequest,
  countMachinesFromRequest,
  machinesPath,
  RuntimeError,
  renewClaimCodeFromRequest,
  runtimeHostsPath,
  runtimeMutators,
} from '@hq/runtime/server'
import { workspaceMutators } from '@hq/workspace/server'
import { getMutator, mustGetMutator, mustGetQuery } from '@rocicorp/zero'
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

export const sessionClassifierOf =
  (
    llmGateway: LlmGateway,
    {
      gatewayUrlOf = () => llmGateway.url,
      headersOf,
      timeoutMilliseconds,
    }: {
      gatewayUrlOf?: (database: Database) => string
      headersOf?: (database: Database, chat: AgentChat) => Record<string, string>
      timeoutMilliseconds?: number
    } = {},
  ) =>
  (database: Database) =>
    createGatewaySessionClassifier({
      gatewayUrl: () => gatewayUrlOf(database),
      virtualKeyOf: createMemberKeyReader((work) => zeroDrizzle(schema, database).transaction(work), llmGateway),
      listedModels: llmGateway.listedModels,
      headersOf: headersOf && ((chat) => headersOf(database, chat)),
      timeoutMilliseconds,
    })

const statusByErrorCode: Record<string, number> = {
  not_admin: 403,
  local_sessions_off: 403,
  host_not_found: 404,
}

type ZeroDatabase = ReturnType<typeof zeroDrizzle<typeof schema, Database>>

const endpointResponse = async (request: string, successStatus: number, endpoint: () => Promise<unknown>) => {
  try {
    const result = await endpoint()
    return result ? Response.json(result, { status: successStatus }) : new Response(null, { status: successStatus })
  } catch (error) {
    if (error instanceof RuntimeError || error instanceof ProfileError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: statusByErrorCode[error.code] ?? 400 },
      )
    console.error(`${request} failed with ${error instanceof Error ? error.name : 'an unknown error'}`)
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
    relayModelCall: llmGateway && createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
  }),
  agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: defaultLlm }),
  fakeLlm,
  hqAgentImage,
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
  hqAgentImage?: string
}) => {
  const mutatorNamed = (name: string) =>
    getMutator(workspaceMutators, name) ??
    getMutator(profileMutators, name) ??
    getMutator(runtimeMutators, name) ??
    mustGetMutator(conversationMutators, name)
  const databaseOf = (databaseName: string | undefined) =>
    databaseName === undefined ? database : testDatabaseByName?.(databaseName)
  const authenticate = createSessionAuthenticator(tokenSecret, findMemberIn(databaseOf))
  const gatewayOf = () => {
    if (!llmGateway) throw new Error('No LLM gateway is configured')
    return llmGateway
  }
  const app = new Hono<{
    Variables: { zeroContext: ZeroContext; zeroDatabase: ZeroDatabase; database: Database }
  }>()
    .get('/health', (context) => context.json({ status: 'ok' }))
    .get('/host', runtimeHosts.upgrade)
    .get('/api/stream', agentBridge.stream(authenticate, databaseOf))
    .get(toolConsentCallbackPath, async (context) =>
      context.html(await toolConsentPageFromRequest(gatewayOf(), new URL(context.req.url).search)),
    )
    .route(
      '/auth',
      createAuthRoutes({ oidc: createOidc(oidc), tokenSecret, appOrigin, database, authenticate, testDatabaseByName }),
    )
    .use('/api/*', async (context, next) => {
      const authentication = await authenticate(context.req.header('authorization'))
      if (authentication.status !== 200)
        return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
      const requestDatabase = databaseOf(authentication.databaseName) ?? database
      context.set('zeroContext', authentication.context)
      context.set('database', requestDatabase)
      context.set('zeroDatabase', zeroDrizzle(schema, requestDatabase))
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
            const response = await transact((tx, name, args) =>
              mutatorNamed(name).fn({ args, tx, ctx: { ...ctx, hqAgentImage } }),
            )
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
    .get(chatRoutingPathOf(':chatId'), async (context) =>
      context.json(
        await readChatRouting(
          (work) => context.get('zeroDatabase').transaction(work),
          context.get('zeroContext'),
          context.req.param('chatId') ?? '',
        ),
      ),
    )
    .post(chatQuestionPathOf(':chatId', ':questionId'), async (context) => {
      const answer = questionAnswerOf(await context.req.json().catch(() => null))
      if (!answer) return context.json({ error: 'invalid_answer' }, 400)
      const { workspaceId, userId } = context.get('zeroContext')
      const status = await agentBridge
        .forDatabase(context.get('database'))
        .answerQuestion(
          { workspaceId, chatId: chatId(context.req.param('chatId') ?? '') },
          userId,
          context.req.param('questionId') ?? '',
          answer,
        )
      return new Response(null, { status })
    })
    .post(chatPlanModePathOf(':chatId'), async (context) => {
      const planMode = planModeOf(await context.req.json().catch(() => null))
      if (!planMode) return context.json({ error: 'invalid_plan_mode' }, 400)
      const { workspaceId, userId } = context.get('zeroContext')
      const status = await agentBridge
        .forDatabase(context.get('database'))
        .setPlanMode({ workspaceId, chatId: chatId(context.req.param('chatId') ?? '') }, userId, planMode.enabled)
      return new Response(null, { status })
    })
    .post(llmCredentialsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return endpointResponse('Adding an LLM credential', 201, async () => {
        await addLlmCredentialFromRequest(
          (work) => context.get('zeroDatabase').transaction(work),
          context.get('zeroContext'),
          body,
          gatewayOf(),
        )
      })
    })
    .get(toolConnectionsPath, () =>
      endpointResponse('Listing tool servers', 200, () => availableToolsFromRequest(gatewayOf())),
    )
    .post(`${toolConnectionsPath}/:tool/:action{connect|refresh|disconnect}`, (context) => {
      const action = context.req.param('action')
      return endpointResponse('A tool connection request', action === 'disconnect' ? 204 : 200, () =>
        toolConnectionFromRequest(
          (work) => context.get('zeroDatabase').transaction(work),
          context.get('zeroContext'),
          gatewayOf(),
          context.req.param('tool'),
          action,
        ),
      )
    })
    .post(runtimeHostsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return endpointResponse('A runtime host request', 201, () =>
        context
          .get('zeroDatabase')
          .transaction((tx) => addRuntimeHostFromRequest(tx, context.get('zeroContext'), body)),
      )
    })
    .get(machinesPath, (context) =>
      endpointResponse('A runtime host request', 200, () =>
        context.get('zeroDatabase').transaction((tx) => countMachinesFromRequest(tx, context.get('zeroContext'))),
      ),
    )
    .post(`${runtimeHostsPath}/:hostId/code`, (context) =>
      endpointResponse('A runtime host request', 200, () =>
        context
          .get('zeroDatabase')
          .transaction((tx) => renewClaimCodeFromRequest(tx, context.get('zeroContext'), context.req.param('hostId'))),
      ),
    )
  if (fakeLlm) app.route('/fake-llm', fakeLlm)
  return app
}
