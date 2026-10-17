import {
  type AgentChat,
  awaitTaskTool,
  genericModelCallNoticeOf,
  guestToolRefusalOf,
  type ModelCallFailure,
  notApprovedOf,
  routerTools,
  type ToolCallDecision,
  type ToolCallFailure,
  toolCallFailureOf,
  toolCallNoticeOf,
  toolGatewayUnreachable,
  toolServerOf,
} from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import type { MemberId } from '@hq/kernel'
import { type createLlmGateway, createMemberKeyReader, createToolCallOwnerAccess } from '@hq/profile/server'
import type { ConnectedHost } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { AgentBridge } from './agent-bridge/bridge.ts'

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
const refusalOf = (message: string) => ({ error: { message, type: 'hq_refused' } })
const routerPath = '/mcp/router'
const routerInfo = { capabilities: { tools: {} }, serverInfo: { name: 'hq-router', version: '1.0.0' } }
type RouterCall = {
  id?: unknown
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const guestMethods = ['initialize', 'ping', 'tools/list', 'tools/call']
const isGuestMethod = (rpc: unknown) => {
  const { id, method } = (rpc ?? {}) as { id?: unknown; method?: unknown }
  const isNotification = id === undefined && String(method).startsWith('notifications/')
  return typeof rpc === 'object' && (guestMethods.includes(String(method)) || isNotification)
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
const relayOrigin = 'http://relay.invalid'
const relayPathOf = (path: string) => {
  const url = URL.parse(path, relayOrigin)
  const isNormalized = url?.origin === relayOrigin && `${url.pathname}${url.search}` === path
  return isNormalized && !/%2e|%2f|%5c/i.test(url.pathname) ? path : ''
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
    const path = relayPathOf(String(frame.path ?? ''))
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
      const runtime = turn ?? (token ? await handlers.toolCallTurn(host, token) : undefined)
      if (!runtime || runtime.delegationId) return answer(401, refusalOf('This runtime has no chat owner'))
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
      if (rpc.method === 'tools/list') return reply({ tools: routerTools })
      if (rpc.method !== 'tools/call')
        return answer(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
      if (!turn) return reply({ content: [{ type: 'text', text: 'This runtime has no active turn' }], isError: true })
      const { task, effort, model, taskId } = rpc.params?.arguments ?? {}
      const { text, isError } =
        rpc.params?.name === awaitTaskTool.name
          ? await handlers.awaitTask({ chat: turn.chat, turn, taskId })
          : await handlers.delegate({ chat: turn.chat, turn, task: String(task ?? ''), effort, model })
      return reply({ content: [{ type: 'text', text }], isError })
    }
    const { keyOf, tools, readOnlyHints } = databaseAccess(database)
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
      const server = toolServerOf(toolName)
      const { ownerId, prompterId, ownerName } = turn
      const call = {
        readOnly: null as boolean | null,
        status: 'refused' as ToolCallStatus,
        decision: 'not_needed' as ToolCallDecision,
        decidedBy: null as MemberId | null,
        calledAt: new Date(),
      }
      const toolError = (text: string) =>
        answer(200, { jsonrpc: '2.0', id: rpc?.id, result: { content: [{ type: 'text', text }], isError: true } })
      const noticeOf = (failure: ToolCallFailure, isReconnect = false) =>
        toolCallNoticeOf(failure, { ownerName, server, isReconnect })
      if (isToolCall && !prompterId) return toolError('This runtime has no active turn')
      const isGuestTurn = prompterId !== null && prompterId !== ownerId
      if (method === 'POST' && (Array.isArray(rpc) || (isGuestTurn && !isGuestMethod(rpc))))
        return answer(200, {
          jsonrpc: '2.0',
          id: rpc?.id ?? null,
          error: { code: -32601, message: 'Method not found' },
        })
      const isGuestCall = isToolCall && isGuestTurn
      try {
        const virtualKey = await keyOf(host.workspaceId, ownerId).catch(() => null)
        if (!virtualKey && isToolCall)
          return toolError(virtualKey === null ? toolGatewayUnreachable : noticeOf('needs_connection'))
        if (!virtualKey) return answer(virtualKey === null ? 502 : 401, unreachable)
        if (rpc?.method === 'initialize')
          await tools.grantAvailableTools(host.workspaceId, ownerId).catch(() => undefined)
        if (isGuestCall && prompterId) {
          const access = await tools.guestToolAccess(host.workspaceId, ownerId, prompterId, toolName).catch(() => null)
          if (!access) return toolError(toolGatewayUnreachable)
          if (access !== 'allowed')
            return toolError(guestToolRefusalOf(access, { ownerName, prompterName: turn.prompterName ?? '', server }))
        }
        const callHeaders = {
          ...picked(headers, toolHeaders),
          authorization: `Bearer ${virtualKey}`,
          'x-bf-dim-chat': turn.chat.chatId,
          'x-bf-dim-prompter': prompterId ?? '',
          'x-bf-dim-owner': ownerId,
          'x-bf-dim-workspace': host.workspaceId,
          ...(isGuestCall && { 'x-bf-mcp-include-clients': server }),
        }
        if (isToolCall) call.readOnly = await isReadOnly(callHeaders, toolName)
        if (isGuestCall && !call.readOnly) {
          Object.assign(
            call,
            await handlers.requestToolApproval({
              chat: turn.chat,
              promptId: turn.promptId,
              ownerId,
              signal,
              approval: {
                server,
                tool: toolName.slice(server.length + 1),
                arguments: JSON.stringify(rpc?.params?.arguments ?? {}),
                prompterName: turn.prompterName ?? '',
                ownerName,
              },
            }),
          )
          if (call.decision !== 'approved') return toolError(notApprovedOf(ownerName))
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
        if (!failure) return answer(200, { jsonrpc: '2.0', id: rpc?.id, result })
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
              tool: toolName.slice(server.length + 1),
              ...call,
            })
            .catch(() => console.error(`Recording a tool call of chat ${turn.chat.chatId} failed`))
      }
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
