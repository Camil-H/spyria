import { type BrowserSettings, log, type MemberId } from '@spyria/kernel'
import type { AgentChat, AgentTransport } from '../contracts/agent.ts'
import {
  type BrowserAnswer,
  type BrowserCommand,
  browserAnswerOf,
  browserAsleepRefusal,
  browserStartFailureOf,
  memberMessageOf,
  visitedAddressOf,
} from '../domain/browser-tools.ts'
import { BrowserUnavailable } from '../domain/errors.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes'> & {
  browserIdleMilliseconds?: number
  browserStartMilliseconds?: number
  browserCommandMilliseconds?: number
}
type Input = { chat: AgentChat; memberId: MemberId }
export type BrowserViewer = { send(message: object): void }
type ControllerMessage = { id?: number; type?: string; result?: unknown; error?: string; [field: string]: unknown }
type Session = {
  key: string
  chat: AgentChat
  memberId: MemberId
  transport: AgentTransport
  socket: { send(data: string): void; close(): void }
  settings: BrowserSettings
  ready: PromiseWithResolvers<void>
  pending: Map<number, PromiseWithResolvers<unknown>>
  viewers: Set<BrowserViewer>
  page?: { url: string; title: string }
  nextId: number
  idleTimer?: ReturnType<typeof setTimeout>
  isClosed: boolean
}

const defaultIdleMilliseconds = 10 * 60_000
const defaultStartMilliseconds = 60_000
const defaultCommandMilliseconds = 90_000
const viewerMessageTypes = ['frame', 'page', 'notice', 'file_chooser', 'download']
const sessions = new Map<string, { starting: Promise<Session>; session?: Session }>()
const keyOf = ({ chat, memberId }: Input) => `${chat.workspaceId}/${chat.chatId}/${memberId}`

const controllerSettingsOf = (settings: BrowserSettings) => ({
  blockInternalNetworks: settings.blockInternalNetworks,
  allowedInternalAddresses: settings.allowedInternalAddresses,
  allowedSites: settings.allowedSites,
  blockedSites: settings.blockedSites,
  downloads: settings.downloads,
  uploads: settings.uploads,
})

const toViewers = (session: Session, message: object) => {
  for (const viewer of session.viewers) viewer.send(message)
}

const close = (session: Session, reason: string) => {
  if (session.isClosed) return
  session.isClosed = true
  clearTimeout(session.idleTimer)
  if (sessions.get(session.key)?.session === session) sessions.delete(session.key)
  session.socket.close()
  session.ready.reject(new BrowserUnavailable(reason))
  for (const pending of session.pending.values()) pending.reject(new BrowserUnavailable(reason))
  session.pending.clear()
  toViewers(session, { type: 'state', state: 'stopped', reason })
}

const touch = (dependencies: Dependencies, session: Session) => {
  clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    close(session, 'idle')
    session.transport.stopBrowser(session.memberId).catch((error) =>
      log.warn({
        event: 'browser.stop_failed',
        body: "Stopping an idle member's browser failed",
        attributes: { 'workspace.id': session.chat.workspaceId, 'chat.id': session.chat.chatId },
        error,
      }),
    )
  }, dependencies.browserIdleMilliseconds ?? defaultIdleMilliseconds)
}

const recordVisit = (dependencies: Dependencies, session: Session, url: unknown) => {
  const address = typeof url === 'string' ? visitedAddressOf(url) : undefined
  if (!address || !session.settings.recordVisits) return
  dependencies.transactor
    .run(({ browser }) =>
      browser.recordVisit({ chatId: session.chat.chatId, memberId: session.memberId, url: address }),
    )
    .catch((error) =>
      log.error({
        event: 'browser.visit_not_recorded',
        body: 'Recording a visited address failed',
        attributes: { 'workspace.id': session.chat.workspaceId, 'chat.id': session.chat.chatId },
        error,
      }),
    )
}

const receive = (dependencies: Dependencies, session: Session, data: string) => {
  let message: ControllerMessage
  try {
    message = JSON.parse(data)
  } catch {
    return
  }
  if (typeof message.id === 'number') {
    const pending = session.pending.get(message.id)
    session.pending.delete(message.id)
    if (typeof message.error === 'string') return pending?.reject(new BrowserUnavailable(message.error))
    return pending?.resolve(message.result)
  }
  if (message.type === 'ready') return session.ready.resolve()
  if (message.type === 'failed') return close(session, String(message.error ?? 'failed'))
  if (message.type === 'visited') return recordVisit(dependencies, session, message.url)
  if (message.type === 'page') session.page = { url: String(message.url ?? ''), title: String(message.title ?? '') }
  if (viewerMessageTypes.includes(String(message.type))) toViewers(session, message)
}

const started = async (dependencies: Dependencies, input: Input): Promise<Session> => {
  const endpoint = await dependencies.runtimes.endpointOf(input.chat)
  if (!endpoint) throw new BrowserUnavailable(browserAsleepRefusal)
  const settings = await dependencies.transactor.run(({ browser }) => browser.settings())
  const { transport } = endpoint
  await transport
    .startBrowser(input.memberId, { signInHours: settings.signInHours ?? undefined })
    .catch((error: unknown) => {
      throw new BrowserUnavailable(browserStartFailureOf(error instanceof Error ? error.message : ''))
    })
  const session: Session = {
    key: keyOf(input),
    ...input,
    transport,
    socket: { send: () => {}, close: () => {} },
    settings,
    ready: Promise.withResolvers(),
    pending: new Map(),
    viewers: new Set(),
    nextId: 1,
    isClosed: false,
  }
  session.ready.promise.catch(() => {})
  session.socket = transport.openBrowser(input.memberId, {
    onOpen: () => {},
    onMessage: (data) => receive(dependencies, session, data),
    onClose: () => close(session, 'stopped'),
  })
  session.socket.send(JSON.stringify({ type: 'settings', settings: controllerSettingsOf(settings) }))
  const timer = setTimeout(
    () => close(session, 'The browser did not start in time'),
    dependencies.browserStartMilliseconds ?? defaultStartMilliseconds,
  )
  await session.ready.promise.finally(() => clearTimeout(timer))
  touch(dependencies, session)
  return session
}

const sessionOf = (dependencies: Dependencies, input: Input) => {
  const key = keyOf(input)
  const existing = sessions.get(key)
  if (existing) return existing.starting
  const entry: { starting: Promise<Session>; session?: Session } = { starting: started(dependencies, input) }
  sessions.set(key, entry)
  entry.starting.then(
    (session) => {
      entry.session = session
    },
    () => sessions.get(key) === entry && sessions.delete(key),
  )
  return entry.starting
}

const sent = (dependencies: Dependencies, session: Session, command: BrowserCommand) => {
  const id = session.nextId++
  const answer = Promise.withResolvers<unknown>()
  session.pending.set(id, answer)
  session.socket.send(JSON.stringify({ ...command, id }))
  touch(dependencies, session)
  const timer = setTimeout(() => {
    session.pending.delete(id)
    answer.reject(new BrowserUnavailable('The browser did not answer in time'))
  }, dependencies.browserCommandMilliseconds ?? defaultCommandMilliseconds)
  return answer.promise.finally(() => clearTimeout(timer))
}

export const runBrowserCommand = async (
  dependencies: Dependencies,
  input: Input & { command: BrowserCommand },
): Promise<BrowserAnswer> => {
  const session = await sessionOf(dependencies, input)
  return browserAnswerOf(await sent(dependencies, session, input.command))
}

export const checkBrowserCommand = async (dependencies: Dependencies, input: Input & { command: BrowserCommand }) =>
  (await sent(dependencies, await sessionOf(dependencies, input), input.command)) === true

const watchedMessageTypes = ['resize', 'frame_ack']

export const watchBrowser = (
  dependencies: Dependencies,
  input: Input & { viewer: BrowserViewer; canBrowse: boolean },
) => {
  const { viewer, canBrowse } = input
  let current: Session | undefined
  let isOpen = true
  const open = async () => {
    viewer.send({ type: 'state', state: 'starting' })
    try {
      const session = await sessionOf(dependencies, input)
      if (!isOpen || session.isClosed) return
      current = session
      session.viewers.add(viewer)
      touch(dependencies, session)
      viewer.send({ type: 'state', state: 'running', canBrowse })
      if (session.page) viewer.send({ type: 'page', ...session.page })
      session.socket.send(JSON.stringify({ type: 'watch' }))
    } catch (error) {
      const reason = error instanceof BrowserUnavailable ? error.message : 'The browser could not start'
      if (!(error instanceof BrowserUnavailable))
        log.error({
          event: 'browser.start_failed',
          body: "Starting a member's browser failed",
          attributes: { 'workspace.id': input.chat.workspaceId, 'chat.id': input.chat.chatId },
          error,
        })
      viewer.send({ type: 'state', state: 'unavailable', reason })
    }
  }
  const leave = () => {
    const session = current
    current = undefined
    if (!session) return
    session.viewers.delete(viewer)
    if (session.viewers.size === 0 && !session.isClosed) session.socket.send(JSON.stringify({ type: 'unwatch' }))
  }
  void open()
  return {
    receive: (received: unknown) => {
      if ((received as { type?: unknown } | null)?.type === 'start') {
        if (current && !current.isClosed) return
        leave()
        return void open()
      }
      const message = memberMessageOf(received)
      const session = current
      if (!message || !session || session.isClosed) return
      if (!canBrowse && !watchedMessageTypes.includes(message.type)) return
      if (message.type !== 'frame_ack') touch(dependencies, session)
      session.socket.send(JSON.stringify(message))
    },
    close: () => {
      isOpen = false
      leave()
    },
  }
}
