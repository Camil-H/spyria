import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createCommandRunner, gatewayRelayAlias, parseCommand } from './commands.ts'
import { createDocker } from './docker.ts'
import { harnessNames } from './harnesses.ts'
import { createModelRelay } from './model-relay.ts'
import {
  type Credentials,
  type CredentialsAction,
  type CredentialsTool,
  credentialsTools,
  readCredentials,
  redacted,
  runCredentialsCommand,
} from './personal.ts'
import { createRelay, type Frame, frameTextOf, messageOf } from './relay.ts'
import { freeMemoryBytes, systemOf } from './system.ts'
import { contextOf, log, startTelemetry, withSpan } from './telemetry.ts'

const givenArguments = process.argv.slice(2)
const isPersonal = givenArguments.includes('--personal')
const [claimUrlArgument] = givenArguments.filter((argument) => argument !== '--personal')
const dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'
const deployment = process.env.SPYRIA_DEPLOYMENT || 'spyria'
const prefix = `${deployment}-`
const docker = createDocker(dockerSocket)
const signInsChangedSignal = 'SIGUSR2'
const containerHostPid = 1
const tellRunningHostSignInsChanged = () => {
  try {
    const hostArguments = readFileSync(`/proc/${containerHostPid}/cmdline`, 'utf8').split('\0')
    if (process.pid !== containerHostPid && hostArguments.includes('--personal'))
      process.kill(containerHostPid, signInsChangedSignal)
  } catch {
    return
  }
}
if (claimUrlArgument === 'health') {
  const relayUrl = `http://127.0.0.1:${process.env.SPYRIA_HOST_GATEWAY_PORT ?? 4000}/`
  const isRelayUp = await fetch(relayUrl).then(Boolean, () => false)
  process.exit(isRelayUp ? 0 : 1)
}
if (claimUrlArgument === 'login' || claimUrlArgument === 'logout') {
  const action: CredentialsAction = claimUrlArgument
  const tool = givenArguments[1] as CredentialsTool
  if (!credentialsTools.includes(tool)) {
    console.error(`Usage: spyria-host ${action} ${credentialsTools.join('|')}`)
    process.exit(2)
  }
  if (action === 'login' && !process.stdin.isTTY) {
    console.error(`Run it in a terminal: docker exec -it ${deployment}-host spyria-host login ${tool}`)
    process.exit(2)
  }
  await runCredentialsCommand(docker, { socketPath: dockerSocket, prefix, tool, action }).catch((error) => {
    console.error(messageOf(error))
    process.exit(1)
  })
  const { signedIn } = await readCredentials(docker, prefix)
  console.log(`${signedIn.includes(tool) ? 'Signed in' : 'Not signed in'} to ${harnessNames[tool]}`)
  tellRunningHostSignInsChanged()
  process.exit(0)
}
if (!claimUrlArgument) {
  console.error(
    `Usage: spyria-host [--personal] <https://spyria.example.com/h/CODE>, or spyria-host login|logout ${credentialsTools.join('|')}`,
  )
  process.exit(2)
}
const telemetry = startTelemetry()
const claimUrl = new URL(claimUrlArgument)
const claimCode = claimUrl.pathname.match(/\/h\/([A-Za-z0-9]+)$/)?.[1]
const socketUrl = new URL('/host', claimUrl)
socketUrl.protocol = claimUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const stateDirectory = process.env.SPYRIA_HOST_STATE_DIR ?? '/state'
const tokenPath = join(stateDirectory, 'token')
const isInContainer = existsSync('/.dockerenv')
const runner = createCommandRunner({
  docker,
  prefix,
  selfContainerId: isInContainer ? hostname() : undefined,
  personal: isPersonal,
})
let credentials: Credentials = { signedIn: [], secrets: [], credentialsChangedAt: {} }
const declaration = async () => {
  if (!isPersonal) return { personal: false }
  credentials = await readCredentials(docker, prefix).catch((error) => {
    log.error({ event: 'host.sign_ins_unreadable', body: 'Reading the sign-ins failed', error })
    return credentials
  })
  return { personal: true, signedIn: credentials.signedIn, credentialsChangedAt: credentials.credentialsChangedAt }
}
let sendToSpyria = (_frame: Frame) => false
let sendSignInsNow: () => Promise<unknown> = declaration
const modelRelay = createModelRelay({
  send: (frame) => sendToSpyria(frame),
  redact: isPersonal ? (text) => redacted(text, credentials.secrets) : undefined,
})
const modelRelayServer = Bun.serve({
  port: Number(process.env.SPYRIA_HOST_GATEWAY_PORT ?? (isInContainer ? 4000 : 0)),
  hostname: '0.0.0.0',
  idleTimeout: 0,
  fetch: modelRelay.fetch,
})
const gatewayUrl = `http://${isInContainer ? gatewayRelayAlias : 'host.docker.internal'}:${modelRelayServer.port}/v1`
const heartbeatMilliseconds = Number(process.env.SPYRIA_HOST_HEARTBEAT_MS ?? 30_000)
const maximumBufferedBytes = 16 * 1024 * 1024
const maximumReconnectDelayMilliseconds = 30_000
let reconnectDelayMilliseconds = 1000

try {
  mkdirSync(stateDirectory, { recursive: true })
  accessSync(stateDirectory, constants.W_OK)
} catch {
  log.error({
    event: 'host.state_not_writable',
    body: 'The state directory is not writable, so the host token could not be kept',
    attributes: { 'host.state_directory': stateDirectory },
  })
  await telemetry.shutdown()
  process.exit(1)
}

let isTokenRefused = false
const storedToken = () => (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : undefined)
const isRefusal = (closeCode: number) => closeCode >= 4000 && closeCode < 4100
const logHelloFailure = (error: unknown) =>
  log.error({ event: 'host.hello_failed', body: 'Saying hello to Spyria failed', error })
const ownContainer = `${prefix}host`
const stopRestarting = async () => {
  const container = await docker<{ Config?: { Hostname?: string } }>('GET', `/containers/${ownContainer}/json`).catch(
    () => undefined,
  )
  if (container?.Config?.Hostname === hostname())
    await docker('POST', `/containers/${ownContainer}/update`, { RestartPolicy: { Name: 'no' } })
}
const exitForGood = () =>
  void stopRestarting()
    .catch((error) =>
      log.warn({ event: 'host.restart_not_stopped', body: 'Turning off the restart of this host failed', error }),
    )
    .then(() => telemetry.shutdown())
    .finally(() => process.exit(1))
type Carrier = Record<string, unknown>

const connect = () => {
  const socket = new WebSocket(socketUrl)
  const send = (frame: Frame) => {
    const text = frameTextOf(frame)
    if (text) socket.send(text)
    else
      log.warn({
        event: 'host.frame_too_large',
        body: 'A frame too large to relay was dropped',
        attributes: { 'host.frame_type': frame.type },
      })
    return text !== undefined
  }
  const relay = createRelay({
    addressOf: runner.originOf,
    send,
    isBackedUp: () => socket.bufferedAmount > maximumBufferedBytes,
    personal: isPersonal ? { secrets: () => credentials.secrets } : undefined,
  })
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const sendHeartbeat = async () => {
    const { signedIn, credentialsChangedAt } = await declaration()
    send({
      type: 'heartbeat',
      memoryFreeBytes: await freeMemoryBytes(),
      running: await runner.runningCount(),
      signedIn,
      credentialsChangedAt,
    })
  }
  const hello = async (token: string) => {
    const system = await systemOf(docker)
    const declared = await declaration()
    if (socket.readyState !== WebSocket.OPEN) return
    send({ type: 'hello', token, gatewayUrl, system, ...declared })
    sendToSpyria = (frame) => socket.readyState === WebSocket.OPEN && send(frame)
    reconnectDelayMilliseconds = 1000
    heartbeatTimer = setInterval(() => sendHeartbeat().catch(() => {}), heartbeatMilliseconds)
    sendSignInsNow = sendHeartbeat
    log.info({ event: 'host.connected', body: 'Connected to Spyria', attributes: { 'server.address': socketUrl.host } })
  }
  const runCommand = (frame: { id?: unknown; op?: unknown; args?: unknown; runtimeId?: unknown } & Carrier) => {
    const startedAt = performance.now()
    const attributes = {
      'host.command': String(frame.op),
      'runtime.id': typeof frame.runtimeId === 'string' ? frame.runtimeId : undefined,
    }
    return withSpan(
      `host command ${String(frame.op)}`,
      {},
      async () => {
        try {
          send({ type: 'res', id: frame.id, data: (await runner.run(parseCommand(frame.op, frame.args))) ?? null })
          log.info({
            event: 'host.command',
            body: 'Host command done',
            attributes: { ...attributes, duration_ms: Math.round(performance.now() - startedAt) },
          })
        } catch (error) {
          log.error({ event: 'host.command', body: 'Host command failed', attributes, error })
          send({ type: 'res', id: frame.id, error: messageOf(error) })
        }
      },
      contextOf(frame),
    )
  }
  socket.onopen = () => {
    const token = storedToken()
    if (token && !isTokenRefused) return void hello(token).catch(logHelloFailure)
    if (claimCode) return send({ type: 'claim', code: claimCode })
    log.error({ event: 'host.unpaired', body: 'No stored token and no code in the URL' })
    exitForGood()
  }
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.type === 'ping') return send({ type: 'pong' })
    if (frame.type === 'token') {
      writeFileSync(tokenPath, frame.token, { mode: 0o600 })
      return void hello(frame.token).catch(logHelloFailure)
    }
    if (frame.type === 'cmd') return void runCommand(frame)
    if (['http', 'ws_connect', 'ws_msg', 'ws_close'].includes(frame.type)) return void relay.handle(frame)
    if (frame.type.startsWith('gw_')) return modelRelay.handle(frame)
    log.warn({
      event: 'host.frame_refused',
      body: 'Refused a frame',
      attributes: { 'host.frame_type': String(frame.type) },
    })
  }
  socket.onclose = (event) => {
    clearInterval(heartbeatTimer)
    relay.closeAll()
    sendToSpyria = () => false
    sendSignInsNow = declaration
    modelRelay.closeAll()
    if (isRefusal(event.code) && storedToken() && claimCode && !isTokenRefused) {
      log.warn({
        event: 'host.token_refused',
        body: 'The host token was refused, pairing again with the code in the URL',
        attributes: { 'host.close_reason': event.reason },
      })
      isTokenRefused = true
      return connect()
    }
    if (isRefusal(event.code)) {
      log.error({
        event: 'host.refused',
        body: 'Spyria refused this host',
        attributes: { 'host.close_reason': event.reason },
      })
      return exitForGood()
    }
    log.warn({
      event: 'host.disconnected',
      body: 'Disconnected from Spyria, reconnecting',
      attributes: { 'host.close_code': event.code },
    })
    setTimeout(connect, reconnectDelayMilliseconds * (0.5 + Math.random()))
    reconnectDelayMilliseconds = Math.min(reconnectDelayMilliseconds * 2, maximumReconnectDelayMilliseconds)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => void telemetry.shutdown().finally(() => process.exit(0)))
if (isPersonal) process.on(signInsChangedSignal, () => void sendSignInsNow().catch(() => {}))
connect()
