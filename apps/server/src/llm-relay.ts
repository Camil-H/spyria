import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  type AgentChat,
  awaitTaskTool,
  genericModelCallNoticeOf,
  githubTools,
  githubToolsInstructions,
  githubToolsPath,
  guestPrompterOf,
  isGuestToolMethod,
  isReadOnlyGitHubTool,
  type ModelCallFailure,
  routerTools,
  type ToolCallDecision,
  type ToolCallFailure,
  toolCallFailureOf,
  toolCallNoticeOf,
  toolGatewayUnreachable,
} from '@spyria/conversation/server'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { isConnectionRefused, log, type MemberId, toolNamePartsOf, withRetries } from '@spyria/kernel'
import { type createLlmGateway, createMemberKeyReader, createToolCallOwnerAccess } from '@spyria/profile/server'
import type { ConnectedHost } from '@spyria/runtime/server'
import { createBudgetGuard } from '@spyria/usage/server'
import type { AgentBridge } from './agent-bridge/bridge.ts'
import { traceHeadersOf, withSpan } from './telemetry.ts'

export type RelayFrame = { sid?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
type Send = (frame: object) => void
type ToolResult = { content?: { text?: string }[]; isError?: boolean }
type ListedTool = { name?: string; annotations?: { readOnlyHint?: boolean } }
type ToolCallStatus = 'succeeded' | 'failed' | 'refused'

const forwardedHeaders = [
  'content-type',
  'accept',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'originator',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
]
const toolHeaders = [...forwardedHeaders, 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const answeredHeaders = ['content-type', 'x-request-id', 'mcp-session-id']
const headTimeoutMilliseconds = 300_000
const readOnlyHintMilliseconds = 10_000
const unreachable = { error: { message: 'The model gateway is unreachable', type: 'gateway_unavailable' } }
const refusalOf = (message: string) => ({ error: { message, type: 'spyria_refused' } })
const routerPath = '/mcp/router'
const spyriaServerInfoOf = (name: string) => ({ capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } })
type RouterCall = {
  id?: unknown
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const methodNotFound = { error: { code: -32601, message: 'Method not found' } }
const toolErrorOf = (text: string) => ({ result: { content: [{ type: 'text', text }], isError: true } })
const picked = (headers: Iterable<[string, string]>, names: string[]) =>
  Object.fromEntries([...headers].filter(([name]) => names.includes(name.toLowerCase())))
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const relayOrigin = 'http://relay.invalid'
const relayPathOf = (path: string) => {
  const url = URL.parse(path, relayOrigin)
  const isNormalized = url?.origin === relayOrigin && `${url.pathname}${url.search}` === path
  return isNormalized && !/%2e|%2f|%5c/i.test(url.pathname) ? path : ''
}
const modelOf = (body: string) => (jsonOf(body) as { model?: unknown } | undefined)?.model?.toString()
const anthropicPathPrefix = '/v1/messages'
const usagePatterns = {
  'gen_ai.usage.input_tokens': /"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/g,
  'gen_ai.usage.output_tokens': /"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g,
}

const usageCarryCharacters = 64

export const createUsageReader = () => {
  let carry = ''
  const usage: Record<string, number> = {}
  return {
    usage,
    read: (text: string) => {
      const scanned = carry + text
      carry = scanned.slice(-usageCarryCharacters)
      if (!scanned.includes('_tokens')) return
      for (const [name, pattern] of Object.entries(usagePatterns))
        for (const match of scanned.matchAll(pattern)) usage[name] = Number(match[1])
    },
  }
}

export const createModelCallRelay = ({
  llmGateway,
  gatewayUrlOf = () => llmGateway.url,
  agentBridge,
  providerHeadersOf,
}: {
  llmGateway: ReturnType<typeof createLlmGateway>
  gatewayUrlOf?: (database: Database) => string
  agentBridge: () => AgentBridge
  providerHeadersOf?: (database: Database, chat: AgentChat) => Record<string, string>
}) => {
  const accessByDatabase = new Map<Database, ReturnType<typeof accessOf>>()
  const accessOf = (database: Database) => {
    const transact: Parameters<typeof createMemberKeyReader>[0] = (work) =>
      zeroDrizzle(schema, database).transaction(work)
    return {
      keyOf: createMemberKeyReader(transact, llmGateway),
      usedUpBudgetOf: createBudgetGuard(transact),
      tools: createToolCallOwnerAccess(transact, llmGateway),
      readOnlyHints: new Map<string, { isReadOnly: boolean; listedAt: number }>(),
    }
  }
  const databaseAccess = (database: Database) => {
    const access = accessByDatabase.get(database) ?? accessOf(database)
    accessByDatabase.set(database, access)
    return access
  }
  return async (database: Database, host: ConnectedHost, frame: RelayFrame, send: Send, signal: AbortSignal) => {
    const sid = frame.sid
    const logToolCallFailure = (chatId: string, error: unknown) =>
      log.error({
        event: 'tool_call.record_failed',
        body: 'Recording a tool call failed',
        attributes: { 'workspace.id': host.workspaceId, 'chat.id': chatId },
        error,
      })
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      send({ type: 'gw_head', sid, status, headers: { 'content-type': 'application/json', ...headers } })
      if (body !== undefined) send({ type: 'gw_chunk', sid, data: JSON.stringify(body) })
      send({ type: 'gw_end', sid })
    }
    const answerRpc = (id: unknown, outcome: object, headers?: Record<string, string>) =>
      answer(200, { jsonrpc: '2.0', id, ...outcome }, headers)
    const stream = async (
      response: Response,
      failedText?: (text: string) => Promise<unknown>,
      read?: (text: string) => void,
    ) => {
      send({ type: 'gw_head', sid, status: response.status, headers: picked(response.headers, answeredHeaders) })
      try {
        if (failedText) {
          const text = await response.text()
          await failedText(text)
          send({ type: 'gw_chunk', sid, data: text })
        } else {
          const decoder = new TextDecoder()
          for await (const chunk of response.body ?? []) {
            const data = decoder.decode(chunk, { stream: true })
            read?.(data)
            send({ type: 'gw_chunk', sid, data })
          }
        }
        send({ type: 'gw_end', sid })
      } catch {
        send({ type: 'gw_error', sid })
      }
    }
    const path = relayPathOf(String(frame.path ?? ''))
    const method = String(frame.method ?? 'POST')
    const isToolPath = path === '/mcp' || path.startsWith('/mcp?')
    if (!path.startsWith('/v1/') && !isToolPath && path !== routerPath && path !== githubToolsPath)
      return answer(404, { error: { message: 'Not found', type: 'not_found' } })
    const headers = Object.entries((frame.headers ?? {}) as Record<string, string>)
    const { authorization, 'x-api-key': apiKey } = picked(headers, ['authorization', 'x-api-key'])
    const token = String(authorization ?? apiKey ?? '').replace(/^Bearer /i, '')
    const handlers = agentBridge().forDatabase(database)
    const body = typeof frame.body === 'string' ? frame.body : ''

    if (path === routerPath || path === githubToolsPath) {
      if (method !== 'POST') return answer(method === 'DELETE' ? 200 : 405, undefined)
      const isRouter = path === routerPath
      const turn = token && isRouter ? await handlers.modelCallTurn(host, token) : undefined
      const runtime = turn ?? (token ? await handlers.toolCallTurn(host, token) : undefined)
      if (!runtime || ('delegationId' in runtime && runtime.delegationId))
        return answer(401, refusalOf('This runtime has no chat owner'))
      const rpc = jsonOf(body) as RouterCall | undefined
      if (rpc?.id === undefined) return answer(202, undefined)
      const reply = (result: object, replyHeaders?: Record<string, string>) =>
        answerRpc(rpc.id, { result }, replyHeaders)
      if (rpc.method === 'initialize')
        return reply(
          {
            protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18',
            ...spyriaServerInfoOf(isRouter ? 'spyria-router' : 'spyria-github'),
            ...(!isRouter && { instructions: githubToolsInstructions }),
          },
          { 'mcp-session-id': crypto.randomUUID() },
        )
      if (rpc.method === 'ping') return reply({})
      if (rpc.method === 'tools/list') return reply({ tools: isRouter ? routerTools : githubTools })
      if (rpc.method !== 'tools/call') return answerRpc(rpc.id, methodNotFound)
      if (!isRouter && 'ownerId' in runtime && runtime.prompterId && runtime.ownerId) {
        const toolName = String(rpc.params?.name ?? '')
        const calledAt = new Date()
        const { isRefused, text, status } = await handlers
          .callGitHubTool({
            chat: runtime.chat,
            memberId: runtime.prompterId,
            name: toolName,
            input: rpc.params?.arguments,
          })
          .then((outcome) => ({ ...outcome, status: outcome.isRefused ? 'refused' : 'succeeded' }) as const)
          .catch((error: unknown) => {
            log.error({
              event: 'github_tool.failed',
              body: 'A GitHub tool call failed',
              attributes: { 'workspace.id': host.workspaceId, 'chat.id': runtime.chat.chatId, 'tool.name': toolName },
              error,
            })
            return { isRefused: true, text: `${toolName} failed`, status: 'failed' } as const
          })
        await handlers
          .recordToolCall(host.workspaceId, {
            chatId: runtime.chat.chatId,
            prompterId: runtime.prompterId,
            ownerId: runtime.ownerId,
            server: 'github',
            tool: toolName,
            readOnly: isReadOnlyGitHubTool(toolName),
            decision: 'not_needed',
            decidedBy: null,
            status,
            calledAt,
          })
          .catch((error) => logToolCallFailure(runtime.chat.chatId, error))
        return reply({ content: [{ type: 'text', text }], isError: isRefused })
      }
      if (!turn) return answerRpc(rpc.id, toolErrorOf('This runtime has no active turn'))
      const { task, effort, model, taskId } = rpc.params?.arguments ?? {}
      const { text, isError } =
        rpc.params?.name === awaitTaskTool.name
          ? await handlers.awaitTask({ chat: turn.chat, turn, taskId })
          : await handlers.delegate({ chat: turn.chat, turn, task: String(task ?? ''), effort, model })
      return reply({ content: [{ type: 'text', text }], isError })
    }
    const { keyOf, usedUpBudgetOf, tools, readOnlyHints } = databaseAccess(database)
    const isAnthropicPath = path.startsWith(anthropicPathPrefix)
    const isTokenCount = path.startsWith(`${anthropicPathPrefix}/count_tokens`)
    const isReadOnly = async (callHeaders: Record<string, string>, toolName: string) => {
      const hint = readOnlyHints.get(toolName)
      if (hint && Date.now() - hint.listedAt <= readOnlyHintMilliseconds) return hint.isReadOnly
      const listed = await fetch(`${gatewayUrlOf(database)}/mcp`, {
        method: 'POST',
        headers: { ...callHeaders, 'x-bf-mcp-include-tools': toolName },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(headTimeoutMilliseconds)]),
      })
        .then((response) => response.text())
        .catch(() => '')
      const { tools: listedTools = [] } = (jsonOf(listed) as { result?: { tools?: ListedTool[] } })?.result ?? {}
      const listedTool = listedTools.find((tool) => tool.name === toolName)
      if (!listedTool) return false
      const isListedReadOnly = listedTool.annotations?.readOnlyHint === true
      readOnlyHints.set(toolName, { isReadOnly: isListedReadOnly, listedAt: Date.now() })
      return isListedReadOnly
    }
    const gatewayCall = (callHeaders: Record<string, string>, timeoutSignal: AbortSignal) =>
      fetch(`${gatewayUrlOf(database)}${isAnthropicPath ? '/anthropic' : ''}${path}`, {
        method,
        headers: callHeaders,
        body: method === 'GET' || method === 'DELETE' ? undefined : body,
        signal: AbortSignal.any([signal, timeoutSignal]),
      })

    if (isToolPath) {
      const turn = token ? await handlers.toolCallTurn(host, token) : undefined
      if (!turn) return answer(401, refusalOf('This runtime has no chat owner'))
      const rpc = jsonOf(body) as
        | { id?: unknown; method?: string; params?: { name?: unknown; arguments?: unknown } }
        | undefined
      const isToolCall = rpc?.method === 'tools/call'
      const toolName = String(rpc?.params?.name ?? '')
      const { server, tool } = toolNamePartsOf(toolName)
      const { ownerId, prompterId, ownerName } = turn
      const call = {
        readOnly: null as boolean | null,
        status: 'refused' as ToolCallStatus,
        decision: 'not_needed' as ToolCallDecision,
        decidedBy: null as MemberId | null,
        calledAt: new Date(),
      }
      const toolError = (text: string) => answerRpc(rpc?.id, toolErrorOf(text))
      const noticeOf = (failure: ToolCallFailure, isReconnect = false) =>
        toolCallNoticeOf(failure, { ownerName, server, isReconnect })
      if (isToolCall && !prompterId) return toolError('This runtime has no active turn')
      const isGuestTurn = guestPrompterOf(turn) !== null
      if (method === 'POST' && (Array.isArray(rpc) || (isGuestTurn && !isGuestToolMethod(rpc))))
        return answerRpc(rpc?.id ?? null, methodNotFound)
      const isGuestCall = isToolCall && isGuestTurn
      try {
        const virtualKey = await keyOf(host.workspaceId, ownerId).catch(() => null)
        if (!virtualKey && isToolCall)
          return toolError(virtualKey === null ? toolGatewayUnreachable : noticeOf('needs_connection'))
        if (!virtualKey) return answer(virtualKey === null ? 502 : 401, unreachable)
        if (rpc?.method === 'initialize') await tools.grantMemberTools(host.workspaceId, ownerId).catch(() => undefined)
        const callHeaders = {
          ...picked(headers, toolHeaders),
          authorization: `Bearer ${virtualKey}`,
          'x-bf-dim-chat': turn.chat.chatId,
          'x-bf-dim-prompter': prompterId ?? '',
          'x-bf-dim-owner': ownerId,
          'x-bf-dim-workspace': host.workspaceId,
          ...(isGuestCall && { 'x-bf-mcp-include-clients': server }),
        }
        if (isToolCall) {
          const { refusal, ...authorization } = await handlers.authorizeToolCall(
            { turn, toolName, toolArguments: rpc?.params?.arguments, signal },
            {
              accessOf: (prompter) => tools.toolCallAccess(host.workspaceId, ownerId, prompter, toolName),
              isReadOnly: () => isReadOnly(callHeaders, toolName),
            },
          )
          Object.assign(call, authorization)
          if (refusal) return toolError(refusal)
        }
        call.status = 'failed'
        let response: Response
        try {
          response = await gatewayCall(callHeaders, AbortSignal.timeout(headTimeoutMilliseconds))
        } catch {
          if (signal.aborted) return
          return isToolCall ? toolError(toolGatewayUnreachable) : answer(502, unreachable)
        }
        if (!isToolCall) return stream(response)
        if (!response.ok) return toolError(toolGatewayUnreachable)
        call.status = 'succeeded'
        if (!response.headers.get('content-type')?.includes('application/json')) return stream(response)
        const result = (jsonOf(await response.text()) as { result?: ToolResult })?.result
        const text = result?.content?.map((part) => part.text ?? '').join('') ?? ''
        if (result?.isError) call.status = 'failed'
        const failure = result?.isError ? toolCallFailureOf(text) : undefined
        if (!failure) return answerRpc(rpc?.id, { result })
        const isReconnect =
          failure === 'needs_connection' && (await tools.flagToolConnection(host.workspaceId, ownerId, server))
        return toolError(noticeOf(failure, isReconnect))
      } finally {
        if (isToolCall && prompterId)
          await handlers
            .recordToolCall(host.workspaceId, {
              chatId: turn.chat.chatId,
              prompterId,
              ownerId,
              server,
              tool,
              ...call,
            })
            .catch((error) => logToolCallFailure(turn.chat.chatId, error))
      }
    }

    const turn = token ? await handlers.modelCallTurn(host, token) : undefined
    if (!turn) return answer(401, refusalOf('This runtime has no active turn'))
    const model = modelOf(body)
    const startedAt = performance.now()
    const usageReader = createUsageReader()
    const callAttributes = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': isAnthropicPath ? 'anthropic' : model?.split('/')[0],
      'gen_ai.request.model': model,
      'workspace.id': host.workspaceId,
      'chat.id': turn.chat.chatId,
      'turn.id': turn.promptId,
    }
    const answered = (status: number, answerBody: unknown) => {
      answer(status, answerBody)
      return { status }
    }
    const relayed = async (): Promise<{ status?: number; isUnexplained?: boolean; gatewayRequestId?: string }> => {
      const record = (failure: ModelCallFailure) => handlers.recordModelCallFailure({ ...turn, model, failure })
      const usedUpBudget = isTokenCount ? null : await usedUpBudgetOf(host.workspaceId, turn.prompterId)
      if (usedUpBudget) return answered(402, refusalOf(await record({ reached: 'over_budget', budget: usedUpBudget })))
      const virtualKey = await keyOf(host.workspaceId, turn.prompterId).catch(() => null)
      if (virtualKey === null) {
        await record({ reached: 'unreachable' })
        return answered(502, unreachable)
      }
      if (!virtualKey) return answered(401, refusalOf(await record({ reached: 'refused' })))
      const headTimeout = new AbortController()
      const timer = setTimeout(() => headTimeout.abort(), headTimeoutMilliseconds)
      let response: Response
      try {
        const modelCall = () =>
          gatewayCall(
            {
              ...picked(headers, forwardedHeaders),
              ...traceHeadersOf(),
              authorization: `Bearer ${virtualKey}`,
              'x-bf-dim-chat': turn.chat.chatId,
              'x-bf-dim-prompter': turn.prompterId,
              'x-bf-dim-owner': turn.ownerId ?? '',
              'x-bf-dim-workspace': host.workspaceId,
              'x-bf-dim-turn': turn.promptId,
              'x-bf-dim-session': turn.sessionId ?? '',
              'x-bf-mcp-include-clients': '',
              ...(turn.delegationId && { 'x-bf-dim-role': 'delegate', 'x-bf-dim-delegation': turn.delegationId }),
              ...providerHeadersOf?.(database, turn.chat),
            },
            headTimeout.signal,
          )
        response = await withRetries(modelCall, {
          attempts: 2,
          timeoutMilliseconds: headTimeoutMilliseconds,
          isRetried: (outcome) => 'error' in outcome && isConnectionRefused(outcome.error),
        })
      } catch {
        if (signal.aborted) return {}
        if (!isTokenCount) await record({ reached: headTimeout.signal.aborted ? 'timeout' : 'unreachable' })
        return answered(502, unreachable)
      } finally {
        clearTimeout(timer)
      }
      let isUnexplained = false
      await stream(
        response,
        response.ok || isTokenCount
          ? undefined
          : async (text) => {
              const notice = await record({ reached: 'answered', status: response.status, body: jsonOf(text) })
              isUnexplained = notice === genericModelCallNoticeOf(response.status)
            },
        usageReader.read,
      )
      return {
        status: response.status,
        isUnexplained,
        gatewayRequestId: response.headers.get('x-request-id') ?? undefined,
      }
    }
    return withSpan(
      `chat ${model ?? 'unknown'}`,
      callAttributes,
      async (span) => {
        const { status, isUnexplained, gatewayRequestId } = await relayed()
        const attributes = {
          ...callAttributes,
          ...usageReader.usage,
          'http.response.status_code': status,
          'gateway.request.id': gatewayRequestId,
        }
        span.setAttributes(Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)))
        log[isUnexplained ? 'error' : status === undefined || status < 400 ? 'info' : 'warn']({
          event: 'gen_ai.call',
          body: isUnexplained ? 'A model call failed without a known cause' : 'Model call relayed',
          attributes: { ...attributes, duration_ms: Math.round(performance.now() - startedAt) },
        })
      },
      agentBridge().turnContextOf(host.workspaceId, turn.promptId),
    )
  }
}

export type ModelCallRelay = ReturnType<typeof createModelCallRelay>
