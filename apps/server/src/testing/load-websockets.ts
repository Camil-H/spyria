import { heapStats } from 'bun:jsc'
import { parseArgs } from 'node:util'
import type { AgentConversation } from '@spyria/conversation/server'
import { acme, alice } from '@spyria/db'
import { createDatabase, resetDatabase } from '@spyria/db/postgres'
import { databaseUrlOf, dropDatabase, migrateDatabase, startTestPostgres } from '@spyria/db/testing'
import { chatId, type LogSeverity, messageId, setLogOutput, workspaceId } from '@spyria/kernel'
import { createAgentBridge } from '../agent-bridge/bridge.ts'
import { createApp } from '../app.ts'
import { issueSessionToken } from '../auth/session-tokens.ts'
import { openSessions } from '../auth/sessions.ts'
import { createRuntimeHostGateway, serverWebSocket } from '../runtime-hosts/gateway.ts'

type ClientCommand =
  | { type: 'open'; url: string; token: string; chatIds: string[]; concurrency: number }
  | { type: 'count' }
  | { type: 'close' }
type ClientReply =
  | { type: 'opened'; subscribed: number; refused: number; milliseconds: number }
  | { type: 'counted'; textFrames: number }
  | { type: 'closed' }

const mebibyte = 1024 * 1024
const tokenSecret = 'load-test-token-secret'
const settleMilliseconds = 500
const waitTimeoutMilliseconds = 300_000
const allowedHeapGrowthBytes = 2 * mebibyte
const allowedHeapGrowthShare = 0.1

const optionsOf = () =>
  parseArgs({
    options: {
      clients: { type: 'boolean', default: false },
      sockets: { type: 'string', default: '1000,5000,10000' },
      'sockets-per-chat': { type: 'string', default: '1' },
      frames: { type: 'string', default: '20' },
      'hold-seconds': { type: 'string', default: '5' },
      concurrency: { type: 'string', default: '200' },
      warmup: { type: 'string', default: '500' },
    },
  }).values

const runClients = () => {
  const sockets: WebSocket[] = []
  let textFrames = 0
  const reply = (message: ClientReply) => process.send?.(message)
  const openSubscribed = (url: string, token: string, chat: string) =>
    new Promise<boolean>((resolve) => {
      const socket = new WebSocket(url)
      sockets.push(socket)
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token }))
        socket.send(JSON.stringify({ type: 'subscribe', chatId: chat }))
      }
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data))
        if (frame.subscribed) return resolve(true)
        if (typeof frame.text === 'string') textFrames += 1
      }
      socket.onclose = () => resolve(false)
      socket.onerror = () => resolve(false)
    })
  const open = async ({ url, token, chatIds, concurrency }: Extract<ClientCommand, { type: 'open' }>) => {
    const startedAt = performance.now()
    let subscribed = 0
    for (let start = 0; start < chatIds.length; start += concurrency) {
      const outcomes = await Promise.all(
        chatIds.slice(start, start + concurrency).map((chat) => openSubscribed(url, token, chat)),
      )
      subscribed += outcomes.filter(Boolean).length
    }
    reply({
      type: 'opened',
      subscribed,
      refused: chatIds.length - subscribed,
      milliseconds: performance.now() - startedAt,
    })
  }
  const closeAll = async () => {
    const closing = sockets.splice(0)
    await Promise.all(
      closing.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve()
            socket.addEventListener('close', () => resolve())
            socket.close()
          }),
      ),
    )
    textFrames = 0
    reply({ type: 'closed' })
  }
  process.on('message', (command: ClientCommand) => {
    if (command.type === 'open') void open(command)
    if (command.type === 'count') reply({ type: 'counted', textFrames })
    if (command.type === 'close') void closeAll()
  })
}

const withAdmin = async <Result>(work: (admin: ReturnType<typeof createDatabase>['$client']) => Promise<Result>) => {
  const admin = createDatabase(databaseUrlOf('postgres')).$client
  try {
    return await work(admin)
  } finally {
    await admin.end({ timeout: 1 })
  }
}
const isPostgresReachable = () =>
  withAdmin((admin) => admin`select 1`).then(
    () => true,
    () => false,
  )

const createLoadDatabase = async (chatCount: number) => {
  if (!(await isPostgresReachable())) await startTestPostgres()
  const name = `spyria_load_${crypto.randomUUID().replaceAll('-', '')}`
  await withAdmin((admin) => admin.unsafe(`create database "${name}"`))
  const database = createDatabase(databaseUrlOf(name))
  await migrateDatabase(database)
  await resetDatabase(database)
  await database.$client.begin(async (sql) => {
    await sql`
      insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, harness, archived, created_at)
      select ${acme}, 'load-chat-' || n, 'runtime', 'private', 'user', ${alice}, 'Load chat', false, null, false, now()
      from generate_series(1, ${chatCount}::int) as n`
    await sql`
      insert into chat_participants (workspace_id, chat_id, user_id, role_id)
      select ${acme}, 'load-chat-' || n, ${alice}, 'owner' from generate_series(1, ${chatCount}::int) as n`
  })
  return {
    database,
    chatIdAt: (index: number) => `load-chat-${index + 1}`,
    drop: async () => {
      await database.$client.end({ timeout: 5 })
      await dropDatabase(name)
    },
  }
}

const fakeRuntimeEvents = () => {
  const listeners = new Map<string, { onMessage(data: string): void }>()
  const conversationOf = (chat: string): AgentConversation => ({
    conversationId: `load-conversation-${chat}`,
    apiKey: 'load-test',
    transport: {
      gatewayUrl: 'http://load-test.invalid/v1',
      fetch: () => Promise.reject(new Error('The load test runtime answers no request')),
      openSocket: (_path, listener) => {
        queueMicrotask(() => {
          listener.onOpen()
          listeners.set(chat, listener)
        })
        return { send: () => {}, close: () => listeners.delete(chat) }
      },
    },
  })
  const tokenEvent = (chat: string, seq: number) =>
    JSON.stringify({
      id: `load-conversation-${chat}:${seq}`,
      seq,
      timestamp: new Date().toISOString(),
      completed: false,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `token ${seq} ` } },
    })
  return { listeners, conversationOf, tokenEvent }
}

type Sample = { rss: number; heapUsed: number; objectCount: number; objectTypeCounts: Record<string, number> }

const sample = async (): Promise<Sample> => {
  Bun.gc(true)
  await Bun.sleep(settleMilliseconds)
  Bun.gc(true)
  const { rss, heapUsed } = process.memoryUsage()
  const { objectCount, objectTypeCounts } = heapStats()
  return { rss, heapUsed, objectCount, objectTypeCounts }
}

const waitUntil = async (isDone: () => boolean | Promise<boolean>, what: string) => {
  for (const deadline = Date.now() + waitTimeoutMilliseconds; !(await isDone()); await Bun.sleep(50))
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${waitTimeoutMilliseconds / 1000} s`)
}

const mebibytesOf = (bytes: number) => (bytes / mebibyte).toFixed(1)
const kibibytesPerSocketOf = (bytes: number, sockets: number) => (bytes / 1024 / sockets).toFixed(2)

const grownObjectTypes = (before: Sample, after: Sample, minimumGrowth: number) =>
  Object.entries(after.objectTypeCounts)
    .map(([type, count]) => [type, count - (before.objectTypeCounts[type] ?? 0)] as const)
    .filter(([, growth]) => growth >= minimumGrowth)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 8)
    .map(([type, growth]) => `${type} +${growth}`)

const runServer = async (options: ReturnType<typeof optionsOf>) => {
  const socketCounts = options.sockets.split(',').map(Number)
  const socketsPerChat = Number(options['sockets-per-chat'])
  const framesPerChat = Number(options.frames)
  const holdMilliseconds = Number(options['hold-seconds']) * 1000
  const concurrency = Number(options.concurrency)
  const warmupSockets = Number(options.warmup)
  const loggedErrors: string[] = []
  setLogOutput((severity: LogSeverity, { event, error }) => {
    if (severity === 'ERROR') loggedErrors.push(`${event}: ${error instanceof Error ? error.message : String(error)}`)
  })

  const { database, chatIdAt, drop } = await createLoadDatabase(
    Math.ceil(Math.max(warmupSockets, ...socketCounts) / socketsPerChat),
  )
  const runtimeHosts = createRuntimeHostGateway({ databases: () => [database], runtimeKeySecret: tokenSecret })
  const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider })
  const app = createApp({
    database,
    tokenSecret,
    oidc: { issuer: 'http://load-test.invalid', clientId: 'spyria', redirectUri: 'http://load-test.invalid/callback' },
    appOrigin: 'http://load-test.invalid',
    runtimeHosts,
    agentBridge,
  })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket: serverWebSocket })
  const [session] = await openSessions(database, alice, acme)
  if (!session) throw new Error('The seeded member has no session in the seeded workspace')
  const { token } = await issueSessionToken(tokenSecret, session)

  const replies: ClientReply[] = []
  const clients = Bun.spawn([process.execPath, import.meta.path, '--clients'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    ipc: (message: ClientReply) => replies.push(message),
  })
  const ask = async <Type extends ClientReply['type']>(command: ClientCommand, replyType: Type) => {
    replies.length = 0
    clients.send(command)
    await waitUntil(() => replies.some((reply) => reply.type === replyType), `The clients' ${replyType} reply`)
    return replies.find((reply) => reply.type === replyType) as Extract<ClientReply, { type: Type }>
  }

  const runRound = async (socketCount: number) => {
    const chatIds = Array.from({ length: socketCount }, (_, index) => chatIdAt(Math.floor(index / socketsPerChat)))
    const distinctChatIds = [...new Set(chatIds)]
    const baseline = await sample()

    const opened = await ask(
      { type: 'open', url: `ws://127.0.0.1:${server.port}/api/stream`, token, chatIds, concurrency },
      'opened',
    )
    await Bun.sleep(holdMilliseconds)
    const held = await sample()

    const bridge = agentBridge.forDatabase(database)
    const runtime = fakeRuntimeEvents()
    for (const chat of distinctChatIds)
      void bridge.ensureOpen(
        { workspaceId: workspaceId(acme), chatId: chatId(chat) },
        runtime.conversationOf(chat),
        messageId(`load-prompt-${chat}`),
      )
    await waitUntil(() => runtime.listeners.size === distinctChatIds.length, 'Opening every runtime event stream')
    const broadcastStartedAt = performance.now()
    for (let seq = 1; seq <= framesPerChat; seq++) {
      for (const chat of distinctChatIds) runtime.listeners.get(chat)?.onMessage(runtime.tokenEvent(chat, seq))
      await Bun.sleep(0)
    }
    const expectedFrames = opened.subscribed * framesPerChat
    await waitUntil(
      async () => (await ask({ type: 'count' }, 'counted')).textFrames >= expectedFrames,
      'Delivering every token frame',
    )
    const broadcastMilliseconds = performance.now() - broadcastStartedAt
    const broadcasted = await sample()

    const closeStartedAt = performance.now()
    await ask({ type: 'close' }, 'closed')
    await waitUntil(
      () => bridge.retained().viewers === 0 && bridge.retained().watchingViewers === 0,
      'Forgetting every closed viewer',
    )
    const closeMilliseconds = performance.now() - closeStartedAt
    agentBridge.release(database)
    const afterClose = await sample()

    const heldHeapGrowth = held.heapUsed - baseline.heapUsed
    const leftHeapGrowth = afterClose.heapUsed - baseline.heapUsed
    const isBackToBaseline = leftHeapGrowth <= Math.max(allowedHeapGrowthBytes, heldHeapGrowth * allowedHeapGrowthShare)
    const row = [
      String(socketCount),
      String(opened.subscribed),
      (opened.milliseconds / 1000).toFixed(1),
      mebibytesOf(baseline.rss),
      mebibytesOf(held.rss),
      kibibytesPerSocketOf(held.rss - baseline.rss, socketCount),
      kibibytesPerSocketOf(heldHeapGrowth, socketCount),
      mebibytesOf(broadcasted.rss),
      `${expectedFrames} in ${(broadcastMilliseconds / 1000).toFixed(1)} s`,
      (closeMilliseconds / 1000).toFixed(1),
      mebibytesOf(afterClose.rss),
      (leftHeapGrowth / mebibyte).toFixed(2),
      String(afterClose.objectCount - baseline.objectCount),
      isBackToBaseline ? 'yes' : 'NO',
    ]
    const findings = [
      ...(opened.refused > 0 ? [`${socketCount} sockets: ${opened.refused} were not subscribed`] : []),
      ...(isBackToBaseline
        ? []
        : [
            `${socketCount} sockets: heap grew by ${mebibytesOf(leftHeapGrowth)} MiB after close; grown types: ${grownObjectTypes(baseline, afterClose, socketCount / 2).join(', ')}`,
          ]),
      `${socketCount} sockets: object types grown while held: ${grownObjectTypes(baseline, held, socketCount / 2).join(', ')}`,
    ]
    return { row, findings, isBackToBaseline }
  }

  await runRound(warmupSockets)
  const firstBaseline = await sample()
  const rounds = []
  for (const socketCount of socketCounts) rounds.push(await runRound(socketCount))
  const finalSample = await sample()
  clients.kill()
  void server.stop(true)
  await runtimeHosts.close()
  await drop()

  const header = [
    'sockets',
    'subscribed',
    'open s',
    'base rss MiB',
    'held rss MiB',
    'rss KiB/socket',
    'heap KiB/socket',
    'broadcast rss MiB',
    'token frames',
    'close s',
    'closed rss MiB',
    'heap left MiB',
    'objects left',
    'back to baseline',
  ]
  process.stdout.write(
    [
      `Bun ${Bun.version}, ${socketsPerChat} socket(s) per chat, ${framesPerChat} token frames per chat, after a ${warmupSockets}-socket warm-up`,
      `| ${header.join(' | ')} |`,
      `|${header.map(() => '---').join('|')}|`,
      ...rounds.map(({ row }) => `| ${row.join(' | ')} |`),
      `Whole run: rss ${mebibytesOf(firstBaseline.rss)} -> ${mebibytesOf(finalSample.rss)} MiB, heap ${mebibytesOf(firstBaseline.heapUsed)} -> ${mebibytesOf(finalSample.heapUsed)} MiB`,
      ...rounds.flatMap(({ findings }) => findings).map((finding) => `- ${finding}`),
      ...(loggedErrors.length > 0
        ? [`- logged errors: ${loggedErrors.length} (${[...new Set(loggedErrors)].slice(0, 5).join('; ')})`]
        : []),
      '',
    ].join('\n'),
  )
  process.exit(rounds.every(({ isBackToBaseline }) => isBackToBaseline) && loggedErrors.length === 0 ? 0 : 1)
}

const options = optionsOf()
if (options.clients) runClients()
else await runServer(options)
