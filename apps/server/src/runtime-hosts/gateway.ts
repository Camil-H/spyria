import { createHmac } from 'node:crypto'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { log, type RuntimeHostId, type WorkspaceId } from '@spyria/kernel'
import {
  type ConnectedHost,
  createHostSessionHandlers,
  HostRefused,
  type HostSessionFrame,
  parseHostSessionFrame,
  type SandboxLocation,
  type SandboxProvider,
  type SandboxResponse,
  type SandboxSocketListener,
  type SandboxStatus,
} from '@spyria/runtime/server'
import { upgradeWebSocket, websocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import type { ModelCallRelay, RelayFrame } from '../llm-relay.ts'
import { traceHeadersOf } from '../telemetry.ts'

type Frame = { type?: unknown; id?: unknown; sid?: unknown; [field: string]: unknown }
type HostSessionHandlers = ReturnType<typeof createHostSessionHandlers>
type Connection = {
  socket: WSContext
  identified?: {
    host: ConnectedHost
    token: string
    handlers: HostSessionHandlers
    database?: Database
    gatewayUrl: string
    relayVersion: number
  }
  missedPings: number
  identifying: PromiseWithResolvers<void>
  pending: Map<number, PromiseWithResolvers<Frame>>
  streams: Map<number, SandboxSocketListener>
  receivedStreamBytes: Map<number, number>
  incomingBodies: Map<number, IncomingBody>
  modelCalls: Map<number, AbortController>
}
type IncomingBody = { head: Frame; parts: Buffer[]; size: number }

const refusedCloseCode = 4001
const replacedCloseCode = 4002
const requestTimeoutMilliseconds = 180_000
const installTimeoutMilliseconds = 240_000
const identifyTimeoutMilliseconds = 10_000
const defaultGatewayRelayUrl = 'http://spyria-gateway-relay:4000/v1'
export const maximumFrameBytes = 64 * 1024 * 1024
const chunkedRelayVersion = 2
const relayChunkBytes = 256 * 1024
const maximumRelayedBodyBytes = 256 * 1024 * 1024
const streamCreditBytes = 1024 * 1024
export const serverWebSocket = {
  ...websocket,
  maxPayloadLength: maximumFrameBytes,
  backpressureLimit: 16 * 1024 * 1024,
  closeOnBackpressureLimit: true,
}

const bodyFramesOf = (sid: number, body: string) => {
  const bytes = Buffer.from(body)
  const frames: object[] = []
  for (let offset = 0; offset < bytes.length; offset += relayChunkBytes)
    frames.push({ type: 'http_body', sid, data: bytes.subarray(offset, offset + relayChunkBytes).toString('base64') })
  return [...frames, { type: 'http_end', sid }]
}

const speaksChunkedRelay = (connection: Connection) => (connection.identified?.relayVersion ?? 1) >= chunkedRelayVersion

const hostAttributesOf = (host: ConnectedHost) => ({ 'workspace.id': host.workspaceId, 'runtime_host.id': host.hostId })
const frameOf = (text: string): Frame => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const createRuntimeHostGateway = ({
  databases,
  pingIntervalMilliseconds = 25_000,
  afterHello,
  relayModelCall,
  spyriaAgentImage,
  runtimeKeySecret,
}: {
  databases: () => Iterable<Database>
  pingIntervalMilliseconds?: number
  afterHello?: (database: Database, host: ConnectedHost) => Promise<unknown>
  relayModelCall?: ModelCallRelay
  spyriaAgentImage?: string
  runtimeKeySecret: string
}) => {
  const connectionByHost = new Map<string, Connection>()
  const operationChains = new Map<string, Promise<unknown>>()
  const keyOf = ({ workspaceId, hostId }: ConnectedHost) => `${workspaceId}/${hostId}`
  let nextRequestId = 1

  const inOrder = <Result>(key: string, work: () => Promise<Result>) => {
    const result = (operationChains.get(key) ?? Promise.resolve()).then(work, work)
    const settled = result.catch(() => {})
    operationChains.set(key, settled)
    settled.then(() => operationChains.get(key) === settled && operationChains.delete(key))
    return result
  }

  const firstAccepted = async <Result>(attempt: (handlers: HostSessionHandlers) => Promise<Result>) => {
    let lastRefusal: unknown
    for (const database of databases()) {
      const handlers = createHostSessionHandlers((work) => zeroDrizzle(schema, database).transaction(work))
      try {
        return { database, handlers, result: await attempt(handlers) }
      } catch (error) {
        if (!(error instanceof HostRefused) || !['code_not_valid', 'host_not_registered'].includes(error.code))
          throw error
        lastRefusal = error
      }
    }
    throw lastRefusal
  }

  const sendTo = (connection: Connection, frame: object) => connection.socket.send(JSON.stringify(frame))

  const release = (connection: Connection) => {
    const { pending, streams, identified, modelCalls } = connection
    connection.identifying.resolve()
    for (const { reject } of pending.values()) reject(new Error('The runtime host disconnected'))
    for (const call of modelCalls.values()) call.abort()
    for (const listener of streams.values()) listener.onClose()
    streams.clear()
    connection.receivedStreamBytes.clear()
    connection.incomingBodies.clear()
    if (!identified || connectionByHost.get(keyOf(identified.host)) !== connection) return
    connectionByHost.delete(keyOf(identified.host))
    inOrder(identified.token, () => identified.handlers.offline(identified.host)).catch((error) =>
      log.error({
        event: 'runtime_host.offline_failed',
        body: 'Marking a runtime host offline failed',
        attributes: hostAttributesOf(identified.host),
        error,
      }),
    )
  }

  const identify = async (connection: Connection, frame: HostSessionFrame) => {
    if (frame.type === 'claim') {
      const { result } = await firstAccepted((handlers) => handlers.claim(frame.code))
      return sendTo(connection, { type: 'token', token: result.token })
    }
    if (frame.type !== 'hello') return connection.socket.close(refusedCloseCode, 'This host is not registered')
    const {
      database,
      handlers,
      result: host,
    } = await firstAccepted((handlers) =>
      inOrder(frame.token, () =>
        handlers.hello(frame, (identifiedHost) => {
          const replaced = connectionByHost.get(keyOf(identifiedHost))
          connection.identified = {
            host: identifiedHost,
            token: frame.token,
            handlers,
            gatewayUrl: frame.gatewayUrl ?? defaultGatewayRelayUrl,
            relayVersion: frame.relayVersion ?? 1,
          }
          connectionByHost.set(keyOf(identifiedHost), connection)
          if (replaced !== connection)
            replaced?.socket.close(replacedCloseCode, 'Replaced by a newer connection of this host')
        }),
      ),
    )
    if (connection.identified) connection.identified.database = database
    connection.identifying.resolve()
    const logFailure = (event: string, body: string) => (error: unknown) =>
      log.error({ event, body, attributes: hostAttributesOf(host), error })
    if (spyriaAgentImage)
      prepare(host, spyriaAgentImage).catch(
        logFailure('runtime_host.prepare_failed', 'Preparing a runtime host failed'),
      )
    handlers
      .reconcile(host, sandboxProvider)
      .catch(logFailure('runtime_host.reconcile_failed', 'Reconciling a runtime host failed'))
      .then(() => afterHello?.(database, host))
      .catch(logFailure('runtime_host.resume_failed', 'Resuming prompts on a runtime host failed'))
  }

  const relayModelCallOf = (connection: Connection, frame: Frame) => {
    const sid = Number(frame.sid)
    const { identified, modelCalls } = connection
    if (frame.type === 'gw_cancel') return modelCalls.get(sid)?.abort()
    if (!identified?.database || !relayModelCall) return sendTo(connection, { type: 'gw_error', sid })
    const call = new AbortController()
    modelCalls.set(sid, call)
    relayModelCall(
      identified.database,
      identified.host,
      frame as RelayFrame,
      (reply) => sendTo(connection, reply),
      call.signal,
    )
      .catch((error) => {
        log.error({
          event: 'gen_ai.call.failed',
          body: 'A model call through a runtime host failed',
          attributes: hostAttributesOf(identified.host),
          error,
        })
        sendTo(connection, { type: 'gw_error', sid })
      })
      .finally(() => modelCalls.delete(sid))
  }

  const receiveBody = (connection: Connection, requestId: number, frame: Frame) => {
    const incoming = connection.incomingBodies.get(requestId)
    if (!incoming) return
    if (frame.type === 'http_end') {
      connection.incomingBodies.delete(requestId)
      return connection.pending
        .get(requestId)
        ?.resolve({ ...incoming.head, body: Buffer.concat(incoming.parts).toString('utf8') })
    }
    const part = Buffer.from(String(frame.data), 'base64')
    incoming.size += part.length
    incoming.parts.push(part)
    if (incoming.size <= maximumRelayedBodyBytes) return
    connection.incomingBodies.delete(requestId)
    connection.pending.get(requestId)?.reject(new Error('The response is too large to relay'))
  }

  const acknowledgeStream = (connection: Connection, sid: number, data: string) => {
    if (!speaksChunkedRelay(connection)) return
    const received = (connection.receivedStreamBytes.get(sid) ?? 0) + Buffer.byteLength(data)
    if (received < streamCreditBytes / 2) return void connection.receivedStreamBytes.set(sid, received)
    connection.receivedStreamBytes.set(sid, 0)
    sendTo(connection, { type: 'ws_ack', sid, bytes: received })
  }

  const settle = (connection: Connection, frame: Frame) => {
    const requestId = Number(frame.id ?? frame.sid)
    if (frame.type === 'res' || frame.type === 'http_res') {
      const pending = connection.pending.get(requestId)
      if (typeof frame.error === 'string') return pending?.reject(new Error(frame.error))
      if (frame.chunked !== true) return pending?.resolve(frame)
      if (pending) connection.incomingBodies.set(requestId, { head: frame, parts: [], size: 0 })
      return
    }
    if (frame.type === 'http_body' || frame.type === 'http_end') return receiveBody(connection, requestId, frame)
    const listener = connection.streams.get(requestId)
    if (frame.type === 'ws_open') listener?.onOpen()
    if (frame.type === 'ws_msg' && listener) {
      listener.onMessage(String(frame.data))
      acknowledgeStream(connection, requestId, String(frame.data))
    }
    if (frame.type === 'ws_close' && connection.streams.delete(requestId)) {
      connection.receivedStreamBytes.delete(requestId)
      listener?.onClose()
    }
  }

  const receive = async (connection: Connection, text: string) => {
    const frame = frameOf(text)
    if (frame.type === 'pong') {
      connection.missedPings = 0
      return
    }
    if (frame.type === 'gw_req' || frame.type === 'gw_cancel') {
      await connection.identifying.promise
      return relayModelCallOf(connection, frame)
    }
    const sessionFrame = parseHostSessionFrame(frame)
    const { identified } = connection
    if (!identified)
      return sessionFrame
        ? identify(connection, sessionFrame)
        : connection.socket.close(refusedCloseCode, 'This host is not registered')
    if (sessionFrame?.type === 'heartbeat')
      return inOrder(identified.token, () => identified.handlers.heartbeat(identified.host, sessionFrame))
    settle(connection, frame)
  }

  const upgrade = upgradeWebSocket(() => {
    const connection: Connection = {
      socket: undefined as never,
      missedPings: 0,
      identifying: Promise.withResolvers(),
      pending: new Map(),
      streams: new Map(),
      receivedStreamBytes: new Map(),
      incomingBodies: new Map(),
      modelCalls: new Map(),
    }
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let identifyTimer: ReturnType<typeof setTimeout> | undefined
    return {
      onOpen: (_, socket) => {
        connection.socket = socket
        identifyTimer = setTimeout(
          () => !connection.identified && socket.close(1008, 'No hello in time'),
          identifyTimeoutMilliseconds,
        )
        pingTimer = setInterval(() => {
          if (connection.missedPings >= 2) return socket.close(1001, 'Missed two pings')
          connection.missedPings++
          sendTo(connection, { type: 'ping' })
        }, pingIntervalMilliseconds)
      },
      onMessage: (event, socket) =>
        receive(connection, String(event.data)).catch((error) => {
          if (error instanceof HostRefused) return socket.close(refusedCloseCode, error.message)
          log.error({ event: 'runtime_host.connection_failed', body: 'A runtime host connection failed', error })
          socket.close(1011, 'Internal error')
        }),
      onClose: () => {
        clearInterval(pingTimer)
        clearTimeout(identifyTimer)
        release(connection)
      },
    }
  })

  const connectionOf = (host: ConnectedHost) => {
    const connection = connectionByHost.get(keyOf(host))
    if (!connection) throw new Error(`Runtime host ${host.hostId} is not connected`)
    return connection
  }

  const request = (
    target: ConnectedHost & { runtimeId?: string },
    frame: object,
    timeoutMilliseconds = requestTimeoutMilliseconds,
    chunkedBody?: string,
  ) => {
    const connection = connectionOf(target)
    const id = nextRequestId++
    const response = Promise.withResolvers<Frame>()
    const timer = setTimeout(
      () => response.reject(new Error(`Runtime host ${target.hostId} did not answer in time`)),
      timeoutMilliseconds,
    )
    connection.pending.set(id, response)
    sendTo(connection, { ...frame, id, sid: id, runtimeId: target.runtimeId, ...traceHeadersOf() })
    if (chunkedBody !== undefined) for (const bodyFrame of bodyFramesOf(id, chunkedBody)) sendTo(connection, bodyFrame)
    return response.promise.finally(() => {
      clearTimeout(timer)
      connection.pending.delete(id)
      connection.incomingBodies.delete(id)
    })
  }

  const command = async (host: ConnectedHost, op: string, args: object, timeoutMilliseconds?: number) =>
    (await request(host, { type: 'cmd', op, args }, timeoutMilliseconds)).data

  const prepare = async (host: ConnectedHost, image: string) => {
    await command(host, 'prepare', { image })
  }

  const commandWithoutResult = (op: string) => async (sandbox: SandboxLocation) => {
    await command(sandbox, op, { runtimeId: sandbox.runtimeId })
  }

  const apiKeyOf: SandboxProvider['apiKeyOf'] = ({ workspaceId, runtimeId }) =>
    createHmac('sha256', runtimeKeySecret).update(`runtime-api-key.${workspaceId}.${runtimeId}`).digest('base64url')

  const sandboxProvider: SandboxProvider = {
    create: async ({ image, ...sandbox }) => {
      await command(sandbox, 'create', { runtimeId: sandbox.runtimeId, image, apiKey: apiKeyOf(sandbox) })
    },
    apiKeyOf,
    start: commandWithoutResult('start'),
    stop: commandWithoutResult('stop'),
    remove: commandWithoutResult('remove'),
    status: async (sandbox) => (await command(sandbox, 'status', { runtimeId: sandbox.runtimeId })) as SandboxStatus,
    hasHarness: async ({ harness, ...sandbox }) =>
      (await command(sandbox, 'installed', { runtimeId: sandbox.runtimeId, harness })) === true,
    installHarness: async ({ harness, ...sandbox }) => {
      await command(sandbox, 'install', { runtimeId: sandbox.runtimeId, harness }, installTimeoutMilliseconds)
    },
    connect: (sandbox) => ({
      gatewayUrl: connectionByHost.get(keyOf(sandbox))?.identified?.gatewayUrl ?? defaultGatewayRelayUrl,
      fetch: async ({ body: requestBody, ...sandboxRequest }) => {
        const isChunked = speaksChunkedRelay(connectionOf(sandbox))
        const { status, headers, body } = isChunked
          ? await request(sandbox, { type: 'http', ...sandboxRequest, chunked: true }, undefined, requestBody ?? '')
          : await request(sandbox, { type: 'http', ...sandboxRequest, body: requestBody })
        return { status, headers, body } as SandboxResponse
      },
      openSocket: (path, listener) => {
        const connection = connectionOf(sandbox)
        const sid = nextRequestId++
        connection.streams.set(sid, listener)
        const credit = speaksChunkedRelay(connection) ? { creditBytes: streamCreditBytes } : {}
        sendTo(connection, { type: 'ws_connect', sid, runtimeId: sandbox.runtimeId, path, ...credit })
        return {
          send: (data) => sendTo(connection, { type: 'ws_msg', sid, data }),
          close: () => {
            connection.receivedStreamBytes.delete(sid)
            if (connection.streams.delete(sid)) sendTo(connection, { type: 'ws_close', sid })
          },
        }
      },
    }),
  }

  return {
    upgrade,
    sandboxProvider,
    prepare,
    disconnect: (workspaceId: WorkspaceId, hostId: RuntimeHostId) =>
      connectionByHost.get(keyOf({ workspaceId, hostId }))?.socket.close(1000, 'Removed'),
    close: async () => {
      for (const connection of connectionByHost.values()) {
        release(connection)
        connection.socket.close(1001, 'The server is shutting down')
      }
      await Promise.all(operationChains.values())
    },
  }
}

export type RuntimeHostGateway = ReturnType<typeof createRuntimeHostGateway>
