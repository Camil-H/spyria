import { type AgentChat, genericModelCallNoticeOf, type ModelCallFailure } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type createLlmGateway, createMemberKeyReader } from '@hq/profile/server'
import type { ConnectedHost } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { AgentBridge } from './agent-bridge/bridge.ts'

export type RelayFrame = { sid?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
type Send = (frame: object) => void

const forwardedHeaders = ['content-type', 'accept', 'user-agent']
const answeredHeaders = ['content-type', 'x-request-id']
const headTimeoutMilliseconds = 300_000
const unreachable = { error: { message: 'The model gateway is unreachable', type: 'gateway_unavailable' } }
const refusalOf = (message: string) => ({ error: { message, type: 'hq_refused' } })

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

export const createModelCallRelay = ({
  gatewayUrlOf,
  llmGateway,
  agentBridge,
  providerHeadersOf,
}: {
  gatewayUrlOf: (database: Database) => string
  llmGateway: ReturnType<typeof createLlmGateway>
  agentBridge: () => AgentBridge
  providerHeadersOf?: (database: Database, chat: AgentChat) => Record<string, string>
}) => {
  const keyReaders = new Map<Database, ReturnType<typeof createMemberKeyReader>>()
  const keyReaderOf = (database: Database) => {
    const reader =
      keyReaders.get(database) ??
      createMemberKeyReader((work) => zeroDrizzle(schema, database).transaction(work), llmGateway)
    keyReaders.set(database, reader)
    return reader
  }
  return async (database: Database, host: ConnectedHost, frame: RelayFrame, send: Send, signal: AbortSignal) => {
    const sid = frame.sid
    const answer = (status: number, body: unknown) => {
      send({ type: 'gw_head', sid, status, headers: { 'content-type': 'application/json' } })
      send({ type: 'gw_chunk', sid, data: JSON.stringify(body) })
      send({ type: 'gw_end', sid })
    }
    const path = String(frame.path ?? '')
    if (!path.startsWith('/v1/')) return answer(404, { error: { message: 'Not found', type: 'not_found' } })
    const headers = Object.entries((frame.headers ?? {}) as Record<string, string>)
    const token = String(picked(headers, ['authorization']).authorization ?? '').replace(/^Bearer /i, '')
    const handlers = agentBridge().forDatabase(database)
    const turn = token ? await handlers.modelCallTurn(host, token) : undefined
    if (!turn) return answer(401, refusalOf('This runtime has no active turn'))
    const body = typeof frame.body === 'string' ? frame.body : ''
    const record = (failure: ModelCallFailure) =>
      handlers.recordModelCallFailure({ ...turn, model: modelOf(body), failure })
    const virtualKey = await keyReaderOf(database)(host.workspaceId, turn.prompterId).catch(() => null)
    if (virtualKey === null) {
      await record({ reached: 'unreachable' })
      return answer(502, unreachable)
    }
    if (!virtualKey) return answer(401, refusalOf(await record({ reached: 'refused' })))
    const headTimeout = new AbortController()
    const timer = setTimeout(() => headTimeout.abort(), headTimeoutMilliseconds)
    let response: Response
    try {
      response = await fetch(`${gatewayUrlOf(database)}${path}`, {
        method: String(frame.method ?? 'POST'),
        headers: {
          ...picked(headers, forwardedHeaders),
          authorization: `Bearer ${virtualKey}`,
          'x-bf-dim-chat': turn.chat.chatId,
          'x-bf-dim-prompter': turn.prompterId,
          'x-bf-dim-owner': turn.ownerId ?? '',
          'x-bf-dim-workspace': host.workspaceId,
          ...providerHeadersOf?.(database, turn.chat),
        },
        body: frame.method === 'GET' ? undefined : body,
        signal: AbortSignal.any([signal, headTimeout.signal]),
      })
    } catch {
      if (signal.aborted) return
      await record({ reached: headTimeout.signal.aborted ? 'timeout' : 'unreachable' })
      return answer(502, unreachable)
    } finally {
      clearTimeout(timer)
    }
    send({ type: 'gw_head', sid, status: response.status, headers: picked(response.headers, answeredHeaders) })
    try {
      if (!response.ok) {
        const text = await response.text()
        const notice = await record({ reached: 'answered', status: response.status, body: jsonOf(text) })
        if (notice === genericModelCallNoticeOf(response.status))
          console.error(
            `A model call failed with ${response.status} (gateway request ${response.headers.get('x-request-id')})`,
          )
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
}

export type ModelCallRelay = ReturnType<typeof createModelCallRelay>
