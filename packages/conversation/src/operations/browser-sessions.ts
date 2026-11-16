import { type BrowserSettings, log, type MemberId } from '@spyria/kernel'
import type { AgentChat, AgentTransport } from '../contracts/agent.ts'
import {
  type BrowserAnswer,
  type BrowserCommand,
  browserAnswerOf,
  browserAsleepRefusal,
  browserDownloadOf,
  browserStartFailureOf,
  imageFileOf,
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
type Session = Input & {
  transport: AgentTransport
  socket: { send(data: string): void; close(): void }
  settings: BrowserSettings
  ready: PromiseWithResolvers<void>
  pending: Map<number, PromiseWithResolvers<unknown>>
  page?: { url: string; title: string }
  nextId: number
  idleTimer?: ReturnType<typeof setTimeout>
  lastVisit?: string
  visitTimes: number[]
  isClosed: boolean
}
type Download = { session: Session; file: string; name: string; size: number; expiresAt: number }
type Slot = {
  starting?: Promise<Session>
  session?: Session
  stopping?: Promise<unknown>
  viewers: Map<BrowserViewer, boolean>
}

const defaultIdleMilliseconds = 10 * 60_000
const defaultStartMilliseconds = 60_000
const defaultCommandMilliseconds = 90_000
const visitWindowMilliseconds = 60_000
const maximumVisitsPerWindow = 30
const viewerMessageTypes = ['frame', 'page', 'notice', 'file_chooser']
const downloadLifetimeMilliseconds = 10 * 60_000
const fileStreamBufferBytes = 4 * 1024 * 1024
const maximumImageBytes = 32 * 1024 * 1024
const downloads = new Map<string, Download>()
const watchedMessageTypes = ['resize', 'frame_ack']
const slots = new Map<string, Slot>()
const keyOf = ({ chat, memberId }: Input) => `${chat.workspaceId}/${chat.chatId}/${memberId}`
const slotOf = (input: Input) => {
  const key = keyOf(input)
  const slot: Slot = slots.get(key) ?? { viewers: new Map() }
  slots.set(key, slot)
  return slot
}
const liveSessionOf = (slot: Slot | undefined) => (slot?.session?.isClosed === false ? slot.session : undefined)
const forgetIfUnused = (input: Input) => {
  const slot = slots.get(keyOf(input))
  if (slot && slot.viewers.size === 0 && !slot.starting && !slot.session && !slot.stopping) slots.delete(keyOf(input))
}

const controllerSettingsOf = (settings: BrowserSettings) => ({
  blockInternalNetworks: settings.blockInternalNetworks,
  allowedInternalAddresses: settings.allowedInternalAddresses,
  allowedSites: settings.allowedSites,
  blockedSites: settings.blockedSites,
  downloads: settings.downloads,
  uploads: settings.uploads,
})

const toViewers = (session: Session, message: object) => {
  for (const viewer of slots.get(keyOf(session))?.viewers.keys() ?? []) viewer.send(message)
}

const showRunning = (session: Session, viewer: BrowserViewer, canBrowse: boolean) => {
  viewer.send({ type: 'state', state: 'running', canBrowse })
  if (session.page) viewer.send({ type: 'page', ...session.page })
}

const close = (session: Session, reason: string) => {
  if (session.isClosed) return
  session.isClosed = true
  clearTimeout(session.idleTimer)
  session.socket.close()
  session.ready.reject(new BrowserUnavailable(reason))
  for (const pending of session.pending.values()) pending.reject(new BrowserUnavailable(reason))
  session.pending.clear()
  const slot = slots.get(keyOf(session))
  if (slot?.session === session) {
    slot.session = undefined
    slot.starting = undefined
  }
  toViewers(session, { type: 'state', state: 'stopped', reason })
  forgetIfUnused(session)
}

const stopIdle = (session: Session) => {
  const slot = slotOf(session)
  close(session, 'idle')
  const stopping = session.transport
    .stopBrowser(session.memberId)
    .catch((error) =>
      log.warn({
        event: 'browser.stop_failed',
        body: "Stopping an idle member's browser failed",
        attributes: { 'workspace.id': session.chat.workspaceId, 'chat.id': session.chat.chatId },
        error,
      }),
    )
    .finally(() => {
      if (slot.stopping === stopping) slot.stopping = undefined
      forgetIfUnused(session)
    })
  slot.stopping = stopping
}

const touch = (dependencies: Dependencies, session: Session) => {
  if (session.isClosed) return
  clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(
    () => stopIdle(session),
    dependencies.browserIdleMilliseconds ?? defaultIdleMilliseconds,
  )
}

const isVisitRecorded = (session: Session, address: string) => {
  const now = Date.now()
  session.visitTimes = session.visitTimes.filter((time) => now - time < visitWindowMilliseconds)
  if (address === session.lastVisit || session.visitTimes.length >= maximumVisitsPerWindow) return false
  session.lastVisit = address
  session.visitTimes.push(now)
  return true
}

const recordVisit = (dependencies: Dependencies, session: Session, url: unknown) => {
  const address = typeof url === 'string' ? visitedAddressOf(url) : undefined
  if (!address || !session.settings.recordVisits || !isVisitRecorded(session, address)) return
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

const controllerMessageOf = (data: string): ControllerMessage | undefined => {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

const fileStreamOf = (session: Session, file: string) => {
  let socket: { close(): void } | undefined
  let resumeReading: (() => void) | undefined
  let isDone = false
  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        socket = session.transport.openBrowserFile(session.memberId, file, {
          onOpen: () => {},
          onMessage: (data) => {
            controller.enqueue(Buffer.from(data, 'base64'))
            if ((controller.desiredSize ?? 0) > 0) return
            return new Promise<void>((resolve) => {
              resumeReading = resolve
            })
          },
          onClose: () => {
            if (isDone) return
            isDone = true
            if (!session.isClosed) session.socket.send(JSON.stringify({ type: 'file_read', file }))
            controller.close()
          },
        })
      },
      pull: () => {
        resumeReading?.()
        resumeReading = undefined
      },
      cancel: () => {
        isDone = true
        socket?.close()
      },
    },
    { highWaterMark: fileStreamBufferBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  )
}

const bytesOf = async (stream: ReadableStream<Uint8Array>, maximumBytes: number) => {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > maximumBytes) {
      await reader.cancel()
      throw new BrowserUnavailable('The screenshot is too large to read')
    }
    parts.push(read.value)
  }
  return Buffer.concat(parts)
}

const offerDownload = (session: Session, message: ControllerMessage) => {
  const download = browserDownloadOf(message)
  if (!download) return
  const now = Date.now()
  for (const [token, { expiresAt }] of downloads) if (expiresAt <= now) downloads.delete(token)
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '')
  downloads.set(token, { session, ...download, expiresAt: now + downloadLifetimeMilliseconds })
  toViewers(session, { type: 'download', token, name: download.name, size: download.size })
}

const handle = (dependencies: Dependencies, session: Session, message: ControllerMessage) => {
  if (typeof message.id === 'number') {
    const pending = session.pending.get(message.id)
    session.pending.delete(message.id)
    if (typeof message.error === 'string') return pending?.reject(new BrowserUnavailable(message.error))
    return pending?.resolve(message.result)
  }
  if (message.type === 'ready') return session.ready.resolve()
  if (message.type === 'failed') return close(session, String(message.error ?? 'failed'))
  if (message.type === 'visited') return recordVisit(dependencies, session, message.url)
  if (message.type === 'download') return offerDownload(session, message)
  if (message.type === 'page') session.page = { url: String(message.url ?? ''), title: String(message.title ?? '') }
  if (viewerMessageTypes.includes(String(message.type))) toViewers(session, message)
}

const receive = (dependencies: Dependencies, session: Session, data: string) => {
  const message = controllerMessageOf(data)
  if (message) handle(dependencies, session, message)
}

const started = async (dependencies: Dependencies, input: Input, slot: Slot): Promise<Session> => {
  await slot.stopping
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
    chat: input.chat,
    memberId: input.memberId,
    transport,
    socket: { send: () => {}, close: () => {} },
    settings,
    ready: Promise.withResolvers(),
    pending: new Map(),
    nextId: 1,
    visitTimes: [],
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
  return session
}

const sessionOf = (dependencies: Dependencies, input: Input) => {
  const slot = slotOf(input)
  const live = liveSessionOf(slot)
  if (live) return Promise.resolve(live)
  if (slot.starting) return slot.starting
  const starting = started(dependencies, input, slot)
  slot.starting = starting
  starting.then(
    (session) => {
      if (slot.starting !== starting) return
      slot.session = session
      touch(dependencies, session)
      for (const [viewer, canBrowse] of slot.viewers) showRunning(session, viewer, canBrowse)
      if (slot.viewers.size > 0) session.socket.send(JSON.stringify({ type: 'watch' }))
    },
    (error: unknown) => {
      if (slot.starting === starting) slot.starting = undefined
      const reason = error instanceof BrowserUnavailable ? error.message : 'The browser could not start'
      if (!(error instanceof BrowserUnavailable))
        log.error({
          event: 'browser.start_failed',
          body: "Starting a member's browser failed",
          attributes: { 'workspace.id': input.chat.workspaceId, 'chat.id': input.chat.chatId },
          error,
        })
      for (const viewer of slot.viewers.keys()) viewer.send({ type: 'state', state: 'unavailable', reason })
      forgetIfUnused(input)
    },
  )
  return starting
}

const sent = (dependencies: Dependencies, session: Session, command: BrowserCommand) => {
  if (session.isClosed) return Promise.reject(new BrowserUnavailable('Your browser stopped'))
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
  const result = await sent(dependencies, session, input.command)
  const imageFile = imageFileOf(result)
  if (!imageFile) return browserAnswerOf(result)
  const image = await bytesOf(fileStreamOf(session, imageFile), maximumImageBytes)
  if (image.byteLength === 0) throw new BrowserUnavailable('The screenshot could not be read')
  return { ...browserAnswerOf(result), image: image.toString('base64') }
}

export const openBrowserDownload = (token: string) => {
  const download = downloads.get(token)
  downloads.delete(token)
  if (!download || download.expiresAt <= Date.now()) return undefined
  return { name: download.name, size: download.size, body: fileStreamOf(download.session, download.file) }
}

export const checkBrowserCommand = async (dependencies: Dependencies, input: Input & { command: BrowserCommand }) =>
  (await sent(dependencies, await sessionOf(dependencies, input), input.command)) === true

export const watchBrowser = (
  dependencies: Dependencies,
  input: Input & { viewer: BrowserViewer; canBrowse: boolean },
) => {
  const { viewer, canBrowse } = input
  const slot = slotOf(input)
  const open = () => {
    const live = liveSessionOf(slot)
    if (live) {
      showRunning(live, viewer, canBrowse)
      touch(dependencies, live)
      return live.socket.send(JSON.stringify({ type: 'watch' }))
    }
    viewer.send({ type: 'state', state: 'starting' })
    sessionOf(dependencies, input).catch(() => {})
  }
  slot.viewers.set(viewer, canBrowse)
  open()
  return {
    receive: (received: unknown) => {
      if ((received as { type?: unknown } | null)?.type === 'start') return liveSessionOf(slot) ? undefined : open()
      const message = memberMessageOf(received)
      const session = liveSessionOf(slot)
      if (!message || !session) return
      if (!canBrowse && !watchedMessageTypes.includes(message.type)) return
      if (message.type !== 'frame_ack') touch(dependencies, session)
      session.socket.send(JSON.stringify(message))
    },
    close: () => {
      slot.viewers.delete(viewer)
      const session = liveSessionOf(slot)
      if (session && slot.viewers.size === 0) session.socket.send(JSON.stringify({ type: 'unwatch' }))
      forgetIfUnused(input)
    },
  }
}
