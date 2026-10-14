import {
  type AgentChat,
  delegateTool,
  genericModelCallNoticeOf,
  type ModelCallFailure,
  type ToolCallFailure,
  toolCallFailureOf,
  toolCallNoticeOf,
  toolGatewayUnreachable,
  toolServerOf,
} from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type createLlmGateway, createMemberKeyReader, createToolCallOwnerAccess } from '@hq/profile/server'
import type { ConnectedHost } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { AgentBridge } from './agent-bridge/bridge.ts'

export type RelayFrame = { sid?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
type Send = (frame: object) => void
type ToolResult = { content?: { text?: string }[]; isError?: boolean }

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
const unreachable = { error: { message: 'The model gateway is unreachable', type: 'gateway_unavailable' } }
const refusalOf = (message: string) => ({ error: { message, type: 'hq_refused' } })
const routerPath = '/mcp/router'
const routerInfo = { capabilities: { tools: {} }, serverInfo: { name: 'hq-router', version: '1.0.0' } }
type RouterCall = {
  id?: unknown
  method?: string
  params?: { protocolVersion?: string; arguments?: Record<string, unknown> }
}

const picked = (headers: Iterable<[string, string]>, names: string[]) =>
  Object.fromEntries([...headers].filter(([name]) => names.includes(name.toLowerCase())))
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const modelOf = (body: string) => (jsonOf(body) as { model?: unknown } | undefined)?.model?.toString()
const anthropicPathPrefix = '/v1/messages'

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
      tools: createToolCallOwnerAccess(transact, llmGateway),
    }
  }
  const databaseAccess = (database: Database) => {
    const access = accessByDatabase.get(database) ?? accessOf(database)
    accessByDatabase.set(database, access)
    return access
  }
  return async (database: Database, host: ConnectedHost, frame: RelayFrame, send: Send, signal: AbortSignal) => {
    const sid = frame.sid
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      send({ type: 'gw_head', sid, status, headers: { 'content-type': 'application/json', ...headers } })
      if (body !== undefined) send({ type: 'gw_chunk', sid, data: JSON.stringify(body) })
      send({ type: 'gw_end', sid })
    }
    const stream = async (response: Response, failedText?: (text: string) => Promise<unknown>) => {
      send({ type: 'gw_head', sid, status: response.status, headers: picked(response.headers, answeredHeaders) })
      try {
        if (failedText) {
          const text = await response.text()
          await failedText(text)
          send({ type: 'gw_chunk', sid, data: text })
        } else {
          const decoder = new TextDecoder()
          for await (const chunk of response.body ?? [])
            send({ type: 'gw_chunk', sid, data: decoder.decode(chunk, { stream: true }) })
        }
        send({ type: 'gw_end', sid })
      } catch {
        send({ type: 'gw_error', sid })
      }
    }
    const path = String(frame.path ?? '')
    const method = String(frame.method ?? 'POST')
    const isToolPath = path === '/mcp' || path.startsWith('/mcp?')
    if (!path.startsWith('/v1/') && !isToolPath && path !== routerPath)
      return answer(404, { error: { message: 'Not found', type: 'not_found' } })
    const headers = Object.entries((frame.headers ?? {}) as Record<string, string>)
    const { authorization, 'x-api-key': apiKey } = picked(headers, ['authorization', 'x-api-key'])
    const token = String(authorization ?? apiKey ?? '').replace(/^Bearer /i, '')
    const handlers = agentBridge().forDatabase(database)
    const body = typeof frame.body === 'string' ? frame.body : ''

    if (path === routerPath) {
      if (method !== 'POST') return answer(method === 'DELETE' ? 200 : 405, undefined)
      const turn = token ? await handlers.modelCallTurn(host, token) : undefined
      const isRuntime = turn ? !turn.delegationId : Boolean(token && (await handlers.toolCallTurn(host, token)))
      if (!isRuntime) return answer(401, refusalOf('This runtime has no chat owner'))
      const rpc = jsonOf(body) as RouterCall | undefined
      if (rpc?.id === undefined) return answer(202, undefined)
      const reply = (result: object, replyHeaders?: Record<string, string>) =>
        answer(200, { jsonrpc: '2.0', id: rpc.id, result }, replyHeaders)
      if (rpc.method === 'initialize')
        return reply(
          { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', ...routerInfo },
          { 'mcp-session-id': crypto.randomUUID() },
        )
      if (rpc.method === 'ping') return reply({})
      if (rpc.method === 'tools/list') return reply({ tools: [delegateTool] })
      if (rpc.method !== 'tools/call')
        return answer(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
      if (!turn) return reply({ content: [{ type: 'text', text: 'This runtime has no active turn' }], isError: true })
      const { task, effort, model, resume } = rpc.params?.arguments ?? {}
      const { text, isError } = await handlers.delegate({
        chat: turn.chat,
        turn,
        toolToken: token,
        task: String(task ?? ''),
        effort,
        model,
        resume,
      })
      return reply({ content: [{ type: 'text', text }], isError })
    }
    const { keyOf, tools } = databaseAccess(database)
    const isAnthropicPath = path.startsWith(anthropicPathPrefix)
    const isTokenCount = path.startsWith(`${anthropicPathPrefix}/count_tokens`)
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
      const rpc = jsonOf(body) as { id?: unknown; method?: string; params?: { name?: unknown } } | undefined
      const isToolCall = rpc?.method === 'tools/call'
      const server = toolServerOf(String(rpc?.params?.name ?? ''))
      const toolError = (text: string) =>
        answer(200, { jsonrpc: '2.0', id: rpc?.id, result: { content: [{ type: 'text', text }], isError: true } })
      const noticeOf = (failure: ToolCallFailure, isReconnect = false) =>
        toolCallNoticeOf(failure, { ownerName: turn.ownerName, server, isReconnect })
      const virtualKey = await keyOf(host.workspaceId, turn.ownerId).catch(() => null)
      if (!virtualKey && isToolCall)
        return toolError(virtualKey === null ? toolGatewayUnreachable : noticeOf('needs_connection'))
      if (!virtualKey) return answer(virtualKey === null ? 502 : 401, unreachable)
      if (rpc?.method === 'initialize')
        await tools.grantAvailableTools(host.workspaceId, turn.ownerId).catch(() => undefined)
      let response: Response
      try {
        response = await gatewayCall(
          {
            ...picked(headers, toolHeaders),
            authorization: `Bearer ${virtualKey}`,
            'x-bf-dim-chat': turn.chat.chatId,
            'x-bf-dim-prompter': turn.prompterId ?? '',
            'x-bf-dim-owner': turn.ownerId,
            'x-bf-dim-workspace': host.workspaceId,
          },
          AbortSignal.timeout(headTimeoutMilliseconds),
        )
      } catch {
        if (signal.aborted) return
        return isToolCall ? toolError(toolGatewayUnreachable) : answer(502, unreachable)
      }
      if (!isToolCall) return stream(response)
      if (!response.ok) return toolError(toolGatewayUnreachable)
      if (!response.headers.get('content-type')?.includes('application/json')) return stream(response)
      const result = (jsonOf(await response.text()) as { result?: ToolResult })?.result
      const text = result?.content?.map((part) => part.text ?? '').join('') ?? ''
      const failure = result?.isError ? toolCallFailureOf(text) : undefined
      if (!failure) return answer(200, { jsonrpc: '2.0', id: rpc?.id, result })
      const isReconnect =
        failure === 'needs_connection' && (await tools.flagToolConnection(host.workspaceId, turn.ownerId, server))
      return toolError(noticeOf(failure, isReconnect))
    }

    const turn = token ? await handlers.modelCallTurn(host, token) : undefined
    if (!turn) return answer(401, refusalOf('This runtime has no active turn'))
    const record = (failure: ModelCallFailure) =>
      handlers.recordModelCallFailure({ ...turn, model: modelOf(body), failure })
    const virtualKey = await keyOf(host.workspaceId, turn.prompterId).catch(() => null)
    if (virtualKey === null) {
      await record({ reached: 'unreachable' })
      return answer(502, unreachable)
    }
    if (!virtualKey) return answer(401, refusalOf(await record({ reached: 'refused' })))
    const headTimeout = new AbortController()
    const timer = setTimeout(() => headTimeout.abort(), headTimeoutMilliseconds)
    let response: Response
    try {
      response = await gatewayCall(
        {
          ...picked(headers, forwardedHeaders),
          authorization: `Bearer ${virtualKey}`,
          'x-bf-dim-chat': turn.chat.chatId,
          'x-bf-dim-prompter': turn.prompterId,
          'x-bf-dim-owner': turn.ownerId ?? '',
          'x-bf-dim-workspace': host.workspaceId,
          'x-bf-mcp-include-clients': '',
          ...(turn.delegationId && { 'x-bf-dim-role': 'delegate', 'x-bf-dim-delegation': turn.delegationId }),
          ...providerHeadersOf?.(database, turn.chat),
        },
        headTimeout.signal,
      )
    } catch {
      if (signal.aborted) return
      if (!isTokenCount) await record({ reached: headTimeout.signal.aborted ? 'timeout' : 'unreachable' })
      return answer(502, unreachable)
    } finally {
      clearTimeout(timer)
    }
    return stream(
      response,
      response.ok || isTokenCount
        ? undefined
        : async (text) => {
            const notice = await record({ reached: 'answered', status: response.status, body: jsonOf(text) })
            if (notice === genericModelCallNoticeOf(response.status))
              console.error(
                `A model call failed with ${response.status} (gateway request ${response.headers.get('x-request-id')})`,
              )
          },
    )
  }
}

export type ModelCallRelay = ReturnType<typeof createModelCallRelay>
