import {
  type AgentChat,
  chatPlanModePathOf,
  chatQuestionPathOf,
  chatRoutingPathOf,
  commandOutputPathOf,
  conversationMutators,
  createGatewaySessionClassifier,
  getChatRouting,
  getCommandOutput,
  planModeOf,
  questionAnswerOf,
} from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { queries, type Transact, type ZeroContext } from '@hq/db/zero-queries'
import { chatId, MissingChatPermission, type RuntimeHostId } from '@hq/kernel'
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
import { HTTPException } from 'hono/http-exception'
import { type AgentBridge, createAgentBridge } from './agent-bridge/bridge.ts'
import { createOidc, type OidcSettings } from './auth/oidc.ts'
import { createAuthRoutes } from './auth/routes.ts'
import { createSessionAuthenticator, errorByStatus } from './auth/session-tokens.ts'
import { findMemberIn } from './auth/sessions.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway, type RuntimeHostGateway } from './runtime-hosts/gateway.ts'

export const defaultLlm = { model: 'openai/fake/fake-model' }
const questionIdPattern = /^[\w-]{1,64}$/
const readRevokingMutations = new Set([
  'conversation.removeMember',
  'conversation.leaveChat',
  'workspace.changeVisibility',
])
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
    Variables: { zeroContext: ZeroContext; transact: Transact; database: Database }
  }>()
    .onError((error, context) => {
      if (error instanceof MissingChatPermission)
        return context.json({ error: error.code, message: error.message }, 403)
      if (error instanceof HTTPException) return error.getResponse()
      console.error(error)
      return context.text('Internal Server Error', 500)
    })
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
      const zeroDatabase = zeroDrizzle(schema, requestDatabase)
      context.set('transact', (work) => zeroDatabase.transaction(work))
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
          handler: async (transact, mutation) => {
            const response = await transact((tx, name, args) =>
              mutatorNamed(name).fn({ args, tx, ctx: { ...ctx, hqAgentImage } }),
            )
            if ('error' in response.result) return response
            if (mutation.name === 'runtime.removeHost')
              runtimeHosts.disconnect(ctx.workspaceId, (mutation.args[0] as { hostId: RuntimeHostId }).hostId)
            if (mutation.name === 'workspace.removeMember') {
              const { memberId } = mutation.args[0] as { memberId: string }
              agentBridge.forDatabase(context.get('database')).closeMemberStreams(ctx.workspaceId, memberId)
              for (const { id } of await context.get('database').$client<{ id: RuntimeHostId }[]>`
                select id from runtime_hosts where workspace_id = ${ctx.workspaceId} and owner_id = ${memberId}`)
                runtimeHosts.disconnect(ctx.workspaceId, id)
            }
            if (readRevokingMutations.has(mutation.name))
              await agentBridge.forDatabase(context.get('database')).revokeUnreadable({
                workspaceId: ctx.workspaceId,
                chatId: chatId((mutation.args[0] as { chatId: string }).chatId),
              })
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
        await context.get('transact')((tx) => getCommandOutput(tx, context.get('zeroContext'), chatId, stepId)),
      )
    })
    .get(chatRoutingPathOf(':chatId'), async (context) =>
      context.json(
        await getChatRouting(context.get('transact'), context.get('zeroContext'), context.req.param('chatId') ?? ''),
      ),
    )
    .post(chatQuestionPathOf(':chatId', ':questionId'), async (context) => {
      const answer = questionAnswerOf(await context.req.json().catch(() => null))
      if (!answer) return context.json({ error: 'invalid_answer' }, 400)
      const questionId = context.req.param('questionId') ?? ''
      if (!questionIdPattern.test(questionId)) return context.json({ error: 'invalid_question' }, 400)
      const { workspaceId, userId } = context.get('zeroContext')
      const status = await agentBridge
        .forDatabase(context.get('database'))
        .answerQuestion({ workspaceId, chatId: chatId(context.req.param('chatId') ?? '') }, userId, questionId, answer)
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
        await addLlmCredentialFromRequest(context.get('transact'), context.get('zeroContext'), body, gatewayOf())
      })
    })
    .get(toolConnectionsPath, () =>
      endpointResponse('Listing tool servers', 200, () => availableToolsFromRequest(gatewayOf())),
    )
    .post(`${toolConnectionsPath}/:tool/:action{connect|refresh|disconnect}`, (context) => {
      const action = context.req.param('action')
      return endpointResponse('A tool connection request', action === 'disconnect' ? 204 : 200, () =>
        toolConnectionFromRequest(
          context.get('transact'),
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
        context.get('transact')((tx) => addRuntimeHostFromRequest(tx, context.get('zeroContext'), body)),
      )
    })
    .get(machinesPath, (context) =>
      endpointResponse('A runtime host request', 200, () =>
        context.get('transact')((tx) => countMachinesFromRequest(tx, context.get('zeroContext'))),
      ),
    )
    .post(`${runtimeHostsPath}/:hostId/code`, (context) =>
      endpointResponse('A runtime host request', 200, () =>
        context.get('transact')((tx) =>
          renewClaimCodeFromRequest(tx, context.get('zeroContext'), context.req.param('hostId')),
        ),
      ),
    )
  if (fakeLlm) app.route('/fake-llm', fakeLlm)
  return app
}
