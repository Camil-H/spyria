import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createCommandRunner, gatewayRelayAlias, parseCommand } from './commands.ts'
import { createDocker } from './docker.ts'
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
import { createRelay, messageOf } from './relay.ts'
import { freeMemoryBytes, systemOf } from './system.ts'

const givenArguments = process.argv.slice(2)
const isPersonal = givenArguments.includes('--personal')
const [claimUrlArgument] = givenArguments.filter((argument) => argument !== '--personal')
const dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'
const prefix = process.env.HQ_HOST_PREFIX ?? 'hq-'
const docker = createDocker(dockerSocket)
const toolNames: Record<CredentialsTool, string> = { claude: 'Claude Code', codex: 'Codex' }
if (claimUrlArgument === 'login' || claimUrlArgument === 'logout') {
  const action: CredentialsAction = claimUrlArgument
  const tool = givenArguments[1] as CredentialsTool
  if (!credentialsTools.includes(tool)) {
    console.error(`Usage: hq-host ${action} ${credentialsTools.join('|')}`)
    process.exit(2)
  }
  if (action === 'login' && !process.stdin.isTTY) {
    console.error(`Run it in a terminal: docker exec -it hq-host hq-host login ${tool}`)
    process.exit(2)
  }
  await runCredentialsCommand(docker, { socketPath: dockerSocket, prefix, tool, action }).catch((error) => {
    console.error(messageOf(error))
    process.exit(1)
  })
  const { signedIn } = await readCredentials(docker, prefix)
  console.log(`${signedIn.includes(tool) ? 'Signed in' : 'Not signed in'} to ${toolNames[tool]}`)
  process.exit(0)
}
if (!claimUrlArgument) {
  console.error('Usage: hq-host [--personal] <https://hq.example.com/h/CODE>, or hq-host login|logout claude|codex')
  process.exit(2)
}
const claimUrl = new URL(claimUrlArgument)
const claimCode = claimUrl.pathname.match(/\/h\/([A-Za-z0-9]+)$/)?.[1]
const socketUrl = new URL('/host', claimUrl)
socketUrl.protocol = claimUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const stateDirectory = process.env.HQ_HOST_STATE_DIR ?? '/state'
const tokenPath = join(stateDirectory, 'token')
const isInContainer = existsSync('/.dockerenv')
const runner = createCommandRunner({
  docker,
  prefix,
  selfContainerId: isInContainer ? hostname() : undefined,
  personal: isPersonal,
})
let credentials: Credentials = { signedIn: [], secrets: [] }
const declaration = async () => {
  if (!isPersonal) return { personal: false }
  credentials = await readCredentials(docker, prefix).catch((error) => {
    console.error(`Reading the sign-ins failed: ${messageOf(error)}`)
    return credentials
  })
  return { personal: true, signedIn: credentials.signedIn }
}
let sendToHq = (_frame: object) => false
const modelRelay = createModelRelay({
  send: (frame) => sendToHq(frame),
  redact: isPersonal ? (text) => redacted(text, credentials.secrets) : undefined,
})
const modelRelayServer = Bun.serve({
  port: Number(process.env.HQ_HOST_GATEWAY_PORT ?? (isInContainer ? 4000 : 0)),
  hostname: '0.0.0.0',
  idleTimeout: 0,
  fetch: modelRelay.fetch,
})
const gatewayUrl = `http://${isInContainer ? gatewayRelayAlias : 'host.docker.internal'}:${modelRelayServer.port}/v1`
const heartbeatMilliseconds = 30_000
const maximumBufferedBytes = 16 * 1024 * 1024
const maximumReconnectDelayMilliseconds = 30_000
let reconnectDelayMilliseconds = 1000

try {
  mkdirSync(stateDirectory, { recursive: true })
  accessSync(stateDirectory, constants.W_OK)
} catch {
  console.error(`The state directory ${stateDirectory} is not writable, so the host token could not be kept`)
  process.exit(1)
}

let isTokenRefused = false
const storedToken = () => (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : undefined)
const isRefusal = (closeCode: number) => closeCode >= 4000 && closeCode < 4100

const connect = () => {
  const socket = new WebSocket(socketUrl)
  const send = (frame: object) => socket.send(JSON.stringify(frame))
  const relay = createRelay({
    addressOf: runner.originOf,
    send,
    isBackedUp: () => socket.bufferedAmount > maximumBufferedBytes,
    personal: isPersonal ? { secrets: () => credentials.secrets } : undefined,
  })
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const sendHeartbeat = async () =>
    send({
      type: 'heartbeat',
      memoryFreeBytes: await freeMemoryBytes(),
      running: await runner.runningCount(),
      signedIn: (await declaration()).signedIn,
    })
  const hello = async (token: string) => {
    send({ type: 'hello', token, gatewayUrl, system: await systemOf(docker), ...(await declaration()) })
    sendToHq = (frame) => socket.readyState === WebSocket.OPEN && (send(frame), true)
    reconnectDelayMilliseconds = 1000
    heartbeatTimer = setInterval(() => sendHeartbeat().catch(() => {}), heartbeatMilliseconds)
    console.log(`Connected to ${socketUrl.origin}`)
  }
  const runCommand = async (frame: { id?: unknown; op?: unknown; args?: unknown }) => {
    try {
      send({
        type: 'res',
        id: frame.id,
        data: (await runner.run(parseCommand(frame.op, frame.args, isPersonal))) ?? null,
      })
    } catch (error) {
      console.error(`Command ${String(frame.op)} failed: ${messageOf(error)}`)
      send({ type: 'res', id: frame.id, error: messageOf(error) })
    }
  }
  socket.onopen = () => {
    const token = storedToken()
    if (token && !isTokenRefused) return void hello(token).catch((error) => console.error(messageOf(error)))
    if (claimCode) return send({ type: 'claim', code: claimCode })
    console.error('No stored token and no code in the URL')
    process.exit(1)
  }
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.type === 'ping') return send({ type: 'pong' })
    if (frame.type === 'token') {
      writeFileSync(tokenPath, frame.token, { mode: 0o600 })
      return void hello(frame.token).catch((error) => console.error(messageOf(error)))
    }
    if (frame.type === 'cmd') return void runCommand(frame)
    if (['http', 'ws_connect', 'ws_msg', 'ws_close'].includes(frame.type)) return void relay.handle(frame)
    if (frame.type.startsWith('gw_')) return modelRelay.handle(frame)
    console.error(`Refused frame ${String(frame.type)}`)
  }
  socket.onclose = (event) => {
    clearInterval(heartbeatTimer)
    relay.closeAll()
    sendToHq = () => false
    modelRelay.closeAll()
    if (isRefusal(event.code) && storedToken() && claimCode && !isTokenRefused) {
      console.error(`${event.reason}; pairing again with the code in the URL`)
      isTokenRefused = true
      return connect()
    }
    if (isRefusal(event.code)) {
      console.error(event.reason)
      process.exit(1)
    }
    console.error(`Disconnected from HQ (${event.code}), reconnecting`)
    setTimeout(connect, reconnectDelayMilliseconds * (0.5 + Math.random()))
    reconnectDelayMilliseconds = Math.min(reconnectDelayMilliseconds * 2, maximumReconnectDelayMilliseconds)
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0))
connect()
