import { randomBytes } from 'node:crypto'
import { getMutator, mustGetMutator, mustGetQuery } from '@rocicorp/zero'
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  type AgentChat,
  chatAttachmentPathOf,
  chatAttachmentsPathOf,
  chatGitPathOf,
  chatMediaPathOf,
  chatPublishPathOf,
  chatQuestionPathOf,
  chatRoutingPathOf,
  chatWorkspacePathOf,
  commandOutputPathOf,
  conversationMutators,
  createGatewaySessionClassifier,
  getAttachment,
  getChatRouting,
  getCommandOutput,
  isGitAction,
  isWorkspaceRead,
  mediaResponseOf,
  type PublishAction,
  questionAnswerOf,
  uploadAttachmentFromRequest,
} from '@spyria/conversation/server'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { queries, type Transact, type ZeroContext } from '@spyria/db/zero-queries'
import {
  chatId,
  DomainError,
  defaultDeployment,
  log,
  MissingChatPermission,
  messageId,
  type RuntimeHostId,
  workspaceId as toWorkspaceId,
} from '@spyria/kernel'
import { onboardingMutators } from '@spyria/onboarding/server'
import {
  addLlmCredentialFromRequest,
  availableToolsFromRequest,
  type createLlmGateway,
  createMemberKeyReader,
  githubConnectionChannel,
  githubConnectionPath,
  llmCredentialsPath,
  profileMutators,
  toolConnectionFromRequest,
  toolConnectionsPath,
  toolConsentCallbackPath,
  toolConsentPageFromRequest,
  workspaceConnectionFromRequest,
  workspaceConnectionsPath,
} from '@spyria/profile/server'
import {
  addRuntimeHostFromRequest,
  countMachinesFromRequest,
  machinesPath,
  renewClaimCodeFromRequest,
  runtimeHostsPath,
  runtimeMutators,
} from '@spyria/runtime/server'
import {
  auditCsvFromRequest,
  auditCsvPath,
  auditLogPath,
  auditPageFromRequest,
  auditRetentionFromRequest,
  auditRetentionPath,
  budgetsFromRequest,
  budgetsPath,
  createBudgetGuard,
  ownBudgetFromRequest,
  ownBudgetPath,
  ownSpendFromRequest,
  ownSpendPath,
  ownSpendTrendFromRequest,
  ownSpendTrendPath,
  spendPath,
  spendTrendPath,
  workspaceSpendFromRequest,
  workspaceSpendTrendFromRequest,
} from '@spyria/usage/server'
import {
  createDevChatFromRequest,
  devChatsPath,
  domainVerificationPath,
  type GitHubSettingsInput,
  githubAppCreatedPath,
  githubAppManifestPath,
  githubBranchesPath,
  githubCallbackPath,
  githubConfiguredPath,
  githubRepositoriesPath,
  githubSettingsPath,
  githubWebhooksPath,
  type InstanceApps,
  type SsoSettingsInput,
  ssoSettingsPath,
  workspaceMutators,
} from '@spyria/workspace/server'
import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { routePath } from 'hono/route'
import { type AgentBridge, createAgentBridge } from './agent-bridge/bridge.ts'
import { createSmtpMailer } from './auth/mail.ts'
import { createOidc, type OidcSettings } from './auth/oidc.ts'
import { type AuthMode, createAuthRoutes } from './auth/routes.ts'
import { createSecretBox } from './auth/secret-box.ts'
import { createSessionAuthenticator, errorByStatus } from './auth/session-tokens.ts'
import { findMemberIn } from './auth/sessions.ts'
import { readSsoSettings, saveSsoSettings, sendDomainVerification } from './auth/sso.ts'
import {
  disconnectGitHub,
  finishGitHubAppCreation,
  finishGitHubConnection,
  type GitHubDependencies,
  githubConnectionOf,
  grantedRepositories,
  isGitHubConfigured,
  readGitHubSettings,
  receiveGitHubWebhook,
  repositoryBranches,
  saveGitHubSettings,
  startGitHubAppCreation,
  startGitHubConnection,
} from './github/github.ts'
import { createGitHubApi, githubDotCom } from './github/github-api.ts'
import { createModelCallRelay } from './llm-relay.ts'
import {
  createRateLimiter,
  limitOfMutation,
  type RateBudgets,
  type RateLimiter,
  rateBudgets,
  rateLimitedBy,
  type TrustedProxy,
} from './rate-limits.ts'
import { createRuntimeHostGateway, type RuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { contextOf, withSpan } from './telemetry.ts'
import { webAppResponse } from './web-app.ts'

const healthCheckMilliseconds = 2000
const passesWithinTimeout = (check: () => Promise<boolean>) =>
  Promise.race([check().catch(() => false), Bun.sleep(healthCheckMilliseconds).then(() => false)])
const questionIdPattern = /^[\w-]{1,64}$/
const readRevokingMutations = new Set([
  'conversation.removeMember',
  'conversation.leaveChat',
  'workspace.changeVisibility',
])
type LlmGateway = ReturnType<typeof createLlmGateway>
type ApiEnvironment = {
  Variables: { zeroContext: ZeroContext; transact: Transact; database: Database; databaseName?: string }
}
type ApiContext = Context<ApiEnvironment>

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
  (database: Database) => {
    const transact: Transact = (work) => zeroDrizzle(schema, database).transaction(work)
    const usedUpBudgetOf = createBudgetGuard(transact)
    return createGatewaySessionClassifier({
      gatewayUrl: () => gatewayUrlOf(database),
      virtualKeyOf: createMemberKeyReader(transact, llmGateway),
      isBudgetUsedUp: async (workspaceId, memberId) => (await usedUpBudgetOf(workspaceId, memberId)) !== null,
      listedModels: llmGateway.listedModels,
      headersOf: headersOf && ((chat) => headersOf(database, chat)),
      timeoutMilliseconds,
    })
  }

const statusByErrorCode: Record<string, number> = {
  missing_workspace_permission: 403,
  missing_chat_permission: 403,
  github_refused: 422,
  github_unreachable: 502,
  local_sessions_off: 403,
  host_not_found: 404,
  attachment_not_allowed: 415,
  attachment_too_large: 413,
  too_many_pending_uploads: 413,
  attachment_storage_full: 413,
  attachment_not_found: 404,
  runtime_media_unavailable: 404,
}

const endpointResponse = async (request: string, successStatus: number, endpoint: () => Promise<unknown>) => {
  try {
    const result = await endpoint()
    if (result instanceof Response) return result
    return result ? Response.json(result, { status: successStatus }) : new Response(null, { status: successStatus })
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: statusByErrorCode[error.code] ?? 400 },
      )
    log.error({ event: 'http.request.failed', body: `${request} failed`, error })
    return Response.json({ error: 'internal' }, { status: 500 })
  }
}

export const createApp = ({
  database,
  tokenSecret,
  oidc,
  authMode = 'dex',
  secretsKey,
  microsoftLoginOrigin,
  instanceSignInApps,
  mail,
  appOrigin,
  deployment = defaultDeployment,
  webDist,
  testDatabaseByName,
  llmGateway,
  runtimeHosts = createRuntimeHostGateway({
    databases: () => [database],
    runtimeKeySecret: secretsKey ?? randomBytes(32).toString('hex'),
    relayModelCall: llmGateway && createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
  }),
  agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, deployment }),
  spyriaAgentImage,
  github,
  rateLimits = rateBudgets,
  rateLimiter: limit = createRateLimiter(rateLimits),
  trustedProxy,
}: {
  database: Database
  tokenSecret: string
  oidc: OidcSettings
  authMode?: AuthMode
  secretsKey?: string
  microsoftLoginOrigin?: string
  instanceSignInApps?: InstanceApps
  mail?: { smtpUrl: string; from: string }
  appOrigin: string
  deployment?: string
  webDist?: string
  testDatabaseByName?: (databaseName: string) => Database
  llmGateway?: LlmGateway
  runtimeHosts?: RuntimeHostGateway
  agentBridge?: AgentBridge
  spyriaAgentImage?: string
  github?: GitHubDependencies
  rateLimits?: RateBudgets
  rateLimiter?: RateLimiter
  trustedProxy?: TrustedProxy
}) => {
  const rateLimited = rateLimitedBy(limit, trustedProxy)
  const mutatorNamed = (name: string) =>
    getMutator(workspaceMutators, name) ??
    getMutator(profileMutators, name) ??
    getMutator(runtimeMutators, name) ??
    getMutator(onboardingMutators, name) ??
    mustGetMutator(conversationMutators, name)
  const databaseOf = (databaseName: string | undefined) =>
    databaseName === undefined ? database : testDatabaseByName?.(databaseName)
  const authenticate = createSessionAuthenticator(tokenSecret, findMemberIn(databaseOf))
  const sso = {
    secretBox: secretsKey ? createSecretBox(secretsKey) : undefined,
    microsoftLoginOrigin,
    instanceApps: instanceSignInApps,
    mailer: mail && createSmtpMailer(mail),
    appOrigin,
  }
  const githubDependencies = github ?? { api: createGitHubApi(githubDotCom), secretBox: sso.secretBox }
  const githubCallbackUrl = `${appOrigin}${githubCallbackPath}`
  const githubConnectionPage = (isConnected: boolean) =>
    `<!doctype html><meta charset="utf-8"><title>GitHub</title><p>${isConnected ? 'GitHub is connected. You can close this window.' : 'GitHub could not be connected. Close this window and try again.'}</p><script>new BroadcastChannel('${githubConnectionChannel}').postMessage(${isConnected});window.close()</script>`
  const gatewayOf = () => {
    if (!llmGateway) throw new Error('No LLM gateway is configured')
    return llmGateway
  }
  const workspaceConnectionResponse = async (context: ApiContext, action: string, connectionId: string) => {
    const body = await context.req.json().catch(() => null)
    return endpointResponse('A workspace connection request', action === 'add' ? 201 : 200, () =>
      workspaceConnectionFromRequest(
        context.get('transact'),
        context.get('zeroContext'),
        gatewayOf(),
        action,
        connectionId,
        body,
      ),
    )
  }
  const app = new Hono<ApiEnvironment>()
    .use((context, next) => {
      const startedAt = performance.now()
      const method = context.req.method
      const incoming = { traceparent: context.req.header('traceparent'), tracestate: context.req.header('tracestate') }
      return withSpan(
        method,
        { 'http.request.method': method, 'url.path': context.req.path },
        async (span) => {
          await next()
          const route = routePath(context, -1)
          const status = context.res.status
          span.updateName(`${method} ${route}`)
          span.setAttributes({ 'http.route': route, 'http.response.status_code': status })
          log.info({
            event: 'http.request',
            body: 'Request handled',
            attributes: {
              'http.request.method': method,
              'url.path': context.req.path,
              'http.route': route,
              'http.response.status_code': status,
              duration_ms: Math.round(performance.now() - startedAt),
              'workspace.id': context.get('zeroContext')?.workspaceId,
            },
          })
        },
        contextOf(incoming),
      )
    })
    .onError((error, context) => {
      if (error instanceof MissingChatPermission)
        return context.json({ error: error.code, message: error.message }, 403)
      if (error instanceof HTTPException) return error.getResponse()
      log.error({ event: 'http.request.failed', body: 'A request failed', error })
      return context.text('Internal Server Error', 500)
    })
    .notFound(
      async (context) =>
        (webDist && (await webAppResponse(webDist, context.req.raw))) || context.text('404 Not Found', 404),
    )
    .get('/health', async (context) => {
      const checks = Object.entries({
        database: () => database.$client`select 1`.then(() => true),
        ...(llmGateway && {
          gateway: () =>
            fetch(`${llmGateway.url}/health`, { signal: AbortSignal.timeout(healthCheckMilliseconds) }).then(
              (response) => response.ok,
            ),
        }),
      })
      const passed = await Promise.all(checks.map(([, check]) => passesWithinTimeout(check)))
      const failing = checks.flatMap(([name], index) => (passed[index] ? [] : [name]))
      return failing.length === 0 ? context.json({ status: 'ok' }) : context.json({ status: 'degraded', failing }, 503)
    })
    .get('/host', rateLimited('hostConnection'), runtimeHosts.upgrade)
    .get('/api/stream', agentBridge.stream(authenticate, databaseOf))
    .get(toolConsentCallbackPath, async (context) =>
      context.html(await toolConsentPageFromRequest(gatewayOf(), new URL(context.req.url).search)),
    )
    .get(githubCallbackPath, async (context) => {
      const { code = '', state = '' } = context.req.query()
      const isConnected = await finishGitHubConnection(databaseOf, githubDependencies, tokenSecret, {
        code,
        state,
      }).catch(() => false)
      return context.html(githubConnectionPage(isConnected), isConnected ? 200 : 400)
    })
    .get(githubAppCreatedPath, async (context) => {
      const { code = '', state = '' } = context.req.query()
      const installationUrl = await finishGitHubAppCreation(databaseOf, githubDependencies, tokenSecret, {
        code,
        state,
      }).catch((error: unknown) =>
        error instanceof DomainError ? error : new Error('The GitHub App could not be created: try again from Spyria'),
      )
      if (typeof installationUrl === 'string') return context.redirect(installationUrl)
      return context.html(
        `<!doctype html><meta charset="utf-8"><title>GitHub App</title><p>${installationUrl.message.replaceAll('<', '&lt;')}</p>`,
        400,
      )
    })
    .post(githubWebhooksPath, rateLimited('githubWebhooks'), async (context) => {
      const testDatabaseName = testDatabaseByName && context.req.query('db')
      const webhookDatabase = (testDatabaseName && databaseOf(testDatabaseName)) || database
      const outcome = await receiveGitHubWebhook(
        webhookDatabase,
        githubDependencies,
        {
          appId: context.req.header('x-github-hook-installation-target-id'),
          event: context.req.header('x-github-event'),
          deliveryId: context.req.header('x-github-delivery'),
          signature: context.req.header('x-hub-signature-256'),
          body: await context.req.text(),
        },
        (card, step) =>
          agentBridge.forDatabase(webhookDatabase).recordPullRequest({
            chat: { workspaceId: toWorkspaceId(card.workspaceId), chatId: chatId(card.chatId) },
            actorId: null,
            step,
            cardId: messageId(card.id),
          }),
      )
      return context.json({ outcome }, outcome === 'refused' ? 401 : outcome === 'ignored' ? 202 : 200)
    })
    .route(
      '/auth',
      createAuthRoutes({
        oidc: createOidc(oidc),
        redirectUri: oidc.redirectUri,
        authMode,
        sso,
        tokenSecret,
        appOrigin,
        deployment,
        database,
        authenticate,
        testDatabaseByName,
        closeSessionStreams: (sessionDatabase, workspaceId, sessionId) =>
          agentBridge.forDatabase(sessionDatabase).closeSessionStreams(workspaceId, sessionId),
        rateLimited,
      }),
    )
    .use('/api/*', async (context, next) => {
      const authentication = await authenticate(context.req.header('authorization'))
      if (authentication.status !== 200)
        return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
      const requestDatabase = databaseOf(authentication.databaseName) ?? database
      context.set('zeroContext', authentication.context)
      context.set('database', requestDatabase)
      context.set('databaseName', authentication.databaseName)
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
              withSpan(`mutate ${name}`, { 'mutation.name': name, 'workspace.id': ctx.workspaceId }, () => {
                const limitName = limitOfMutation(name, args)
                const requester = { ...ctx, databaseName: context.get('databaseName') }
                if (limitName) limit(limitName, requester)
                const limitMessage = (isPrompt: boolean) => limit(isPrompt ? 'prompts' : 'messages', requester)
                return mutatorNamed(name).fn({ args, tx, ctx: { ...ctx, spyriaAgentImage, limitMessage } })
              }),
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
            if (mutation.name === 'workspace.deleteWorkspace')
              agentBridge.forDatabase(context.get('database')).closeWorkspaceStreams(ctx.workspaceId)
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
    .get(chatWorkspacePathOf(':chatId', ':read'), async (context) => {
      const read = context.req.param('read') ?? ''
      if (!isWorkspaceRead(read)) return context.json({ error: 'invalid_read' }, 400)
      const { workspaceId, userId } = context.get('zeroContext')
      return context.json(
        await agentBridge
          .forDatabase(context.get('database'))
          .readWorkspace(
            { workspaceId, chatId: chatId(context.req.param('chatId') ?? '') },
            userId,
            read,
            context.req.query('path') ?? '',
          ),
      )
    })
    .post(chatAttachmentsPathOf(':chatId'), rateLimited('uploads'), (context) =>
      endpointResponse('Uploading an attachment', 201, async () =>
        uploadAttachmentFromRequest(context.get('transact'), context.get('zeroContext'), {
          chatId: context.req.param('chatId') ?? '',
          name: context.req.query('name') ?? '',
          request: context.req.raw,
        }),
      ),
    )
    .get(chatAttachmentPathOf(':chatId', ':attachmentId'), rateLimited('attachmentReads'), (context) =>
      endpointResponse('Reading an attachment', 200, async () =>
        mediaResponseOf({
          ...(await context.get('transact')((tx) =>
            getAttachment(
              tx,
              context.get('zeroContext'),
              context.req.param('chatId') ?? '',
              context.req.param('attachmentId') ?? '',
            ),
          )),
          isImmutable: true,
        }),
      ),
    )
    .get(chatMediaPathOf(':chatId'), rateLimited('runtimeMediaReads'), (context) => {
      const { workspaceId, userId } = context.get('zeroContext')
      const path = context.req.query('path') ?? ''
      return endpointResponse('Reading a runtime file', 200, async () =>
        mediaResponseOf({
          ...(await agentBridge
            .forDatabase(context.get('database'))
            .readRuntimeMedia({ workspaceId, chatId: chatId(context.req.param('chatId') ?? '') }, userId, path)),
          name: path.split('/').at(-1) ?? 'file',
          isImmutable: false,
        }),
      )
    })
    .post(chatPublishPathOf(':chatId', ':action{push|pull_request}'), async (context) => {
      const { title, body } = ((await context.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const { workspaceId, userId } = context.get('zeroContext')
      const publication = await agentBridge.forDatabase(context.get('database')).publishBranch({
        chat: { workspaceId, chatId: chatId(context.req.param('chatId') ?? '') },
        memberId: userId,
        action: context.req.param('action') as PublishAction,
        draft: { title: typeof title === 'string' ? title : '', body: typeof body === 'string' ? body : '' },
      })
      return context.json(publication, publication.isRefused ? 403 : 200)
    })
    .post(chatGitPathOf(':chatId', ':action'), async (context) => {
      const action = context.req.param('action') ?? ''
      if (!isGitAction(action)) return context.json({ error: 'invalid_action' }, 400)
      const { message } = ((await context.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
      const { workspaceId, userId } = context.get('zeroContext')
      const outcome = await agentBridge.forDatabase(context.get('database')).runGitAction({
        chat: { workspaceId, chatId: chatId(context.req.param('chatId') ?? '') },
        memberId: userId,
        action,
        message: typeof message === 'string' ? message : '',
      })
      return context.json(outcome, outcome.isRefused ? 403 : 200)
    })
    .post(chatWorkspacePathOf(':chatId', 'wake'), async (context) => {
      const { workspaceId, userId } = context.get('zeroContext')
      await agentBridge
        .forDatabase(context.get('database'))
        .wakeWorkspace({ workspaceId, chatId: chatId(context.req.param('chatId') ?? '') }, userId)
      return new Response(null, { status: 204 })
    })
    .post(llmCredentialsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return endpointResponse('Adding an LLM credential', 201, async () => {
        await addLlmCredentialFromRequest(context.get('transact'), context.get('zeroContext'), body, gatewayOf())
      })
    })
    .get(auditLogPath, (context) =>
      endpointResponse('Reading the audit log', 200, () =>
        auditPageFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query()),
      ),
    )
    .get(auditCsvPath, (context) =>
      endpointResponse('Exporting the audit log', 200, async () => {
        const csv = await auditCsvFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query())
        return new Response(csv.pipeThrough(new TextEncoderStream()), {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="audit-log.csv"',
          },
        })
      }),
    )
    .get(spendPath, (context) =>
      endpointResponse('Reading the workspace spend', 200, () =>
        workspaceSpendFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query()),
      ),
    )
    .get(ownSpendPath, (context) =>
      endpointResponse('Reading own usage', 200, () =>
        ownSpendFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query()),
      ),
    )
    .get(spendTrendPath, (context) =>
      endpointResponse('Reading the workspace spend over time', 200, () =>
        workspaceSpendTrendFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query()),
      ),
    )
    .get(ownSpendTrendPath, (context) =>
      endpointResponse('Reading own usage over time', 200, () =>
        ownSpendTrendFromRequest(context.get('transact'), context.get('zeroContext'), context.req.query()),
      ),
    )
    .get(auditRetentionPath, (context) =>
      endpointResponse('Reading the audit retention', 200, () =>
        auditRetentionFromRequest(context.get('transact'), context.get('zeroContext')),
      ),
    )
    .post(auditRetentionPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return endpointResponse('Saving the audit retention', 200, () =>
        auditRetentionFromRequest(context.get('transact'), context.get('zeroContext'), body),
      )
    })
    .get(budgetsPath, (context) =>
      endpointResponse('Reading the budgets', 200, () =>
        budgetsFromRequest(context.get('transact'), context.get('zeroContext')),
      ),
    )
    .post(budgetsPath, async (context) => {
      const body = await context.req.json().catch(() => null)
      return endpointResponse('Saving a budget', 200, () =>
        budgetsFromRequest(context.get('transact'), context.get('zeroContext'), body),
      )
    })
    .get(ownBudgetPath, (context) =>
      endpointResponse('Reading own budget', 200, () =>
        ownBudgetFromRequest(context.get('transact'), context.get('zeroContext')),
      ),
    )
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
    .post(workspaceConnectionsPath, (context) => workspaceConnectionResponse(context, 'add', ''))
    .post(`${workspaceConnectionsPath}/:connectionId/:action{edit|remove|tools|restrict}`, (context) =>
      workspaceConnectionResponse(context, context.req.param('action'), context.req.param('connectionId')),
    )
    .get(ssoSettingsPath, (context) =>
      endpointResponse('Reading the SSO settings', 200, async () => ({
        settings: await readSsoSettings(context.get('database'), context.get('zeroContext')),
      })),
    )
    .post(ssoSettingsPath, async (context) => {
      const input = ((await context.req.json().catch(() => null)) ?? {}) as SsoSettingsInput
      return endpointResponse('Saving the SSO settings', 200, async () => ({
        settings: await saveSsoSettings(context.get('database'), sso, context.get('zeroContext'), input),
      }))
    })
    .post(domainVerificationPath, rateLimited('verificationEmails'), async (context) => {
      const input = (await context.req.json().catch(() => null)) ?? {}
      return endpointResponse('Sending a domain verification', 200, async () => ({
        settings: await sendDomainVerification(context.get('database'), sso, context.get('zeroContext'), input),
      }))
    })
    .get(githubSettingsPath, (context) =>
      endpointResponse('Reading the GitHub settings', 200, async () => ({
        settings: await readGitHubSettings(context.get('database'), githubDependencies, context.get('zeroContext')),
      })),
    )
    .get(githubConfiguredPath, (context) =>
      endpointResponse('Reading whether GitHub is configured', 200, async () => ({
        configured: await isGitHubConfigured(context.get('database'), context.get('zeroContext')),
      })),
    )
    .post(githubSettingsPath, async (context) => {
      const input = ((await context.req.json().catch(() => null)) ?? {}) as GitHubSettingsInput
      return endpointResponse('Saving the GitHub settings', 200, async () => ({
        settings: await saveGitHubSettings(
          context.get('database'),
          githubDependencies,
          context.get('zeroContext'),
          input,
        ),
      }))
    })
    .post(githubAppManifestPath, async (context) => {
      const { organization } = (await context.req.json().catch(() => null)) ?? {}
      return endpointResponse('Starting the GitHub App creation', 200, () =>
        startGitHubAppCreation(context.get('database'), githubDependencies, context.get('zeroContext'), {
          tokenSecret,
          appOrigin,
          databaseName: context.get('databaseName'),
          organization,
        }),
      )
    })
    .get(githubRepositoriesPath, (context) =>
      endpointResponse('Listing GitHub repositories', 200, async () => ({
        repositories: await grantedRepositories(
          context.get('database'),
          githubDependencies,
          context.get('zeroContext').workspaceId,
        ),
      })),
    )
    .get(githubBranchesPath, (context) =>
      endpointResponse('Listing GitHub branches', 200, async () => ({
        branches: await repositoryBranches(
          context.get('database'),
          githubDependencies,
          context.get('zeroContext').workspaceId,
          context.req.query('repository') ?? '',
        ),
      })),
    )
    .post(devChatsPath, rateLimited('runtimeCreation'), async (context) => {
      const body = await context.req.json().catch(() => null)
      const database = context.get('database')
      const { workspaceId } = context.get('zeroContext')
      return endpointResponse('Creating a dev chat', 201, () =>
        createDevChatFromRequest(context.get('transact'), context.get('zeroContext'), body, {
          branches: (fullName) => repositoryBranches(database, githubDependencies, workspaceId, fullName),
        }),
      )
    })
    .get(githubConnectionPath, (context) =>
      endpointResponse('Reading the GitHub connection', 200, async () => ({
        connection: await githubConnectionOf(context.get('database'), githubDependencies, context.get('zeroContext')),
      })),
    )
    .post(`${githubConnectionPath}/:action{connect|disconnect}`, (context) =>
      endpointResponse('A GitHub connection request', 200, async () => {
        const member = context.get('zeroContext')
        const database = context.get('database')
        if (context.req.param('action') === 'disconnect') return void (await disconnectGitHub(database, member))
        return startGitHubConnection(database, githubDependencies, member, {
          tokenSecret,
          callbackUrl: githubCallbackUrl,
          databaseName: context.get('databaseName'),
        })
      }),
    )
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
  return app
}
