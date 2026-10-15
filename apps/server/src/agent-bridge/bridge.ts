import {
  type AgentChat,
  type AgentConversation,
  type AgentEvent,
  type AgentLlm,
  createAgentHandlers,
  isStoredAgentEvent,
  type SessionClassifier,
  streamedTextOf,
} from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import type { ZeroContext } from '@hq/db/zero-queries'
import { chatId, type MessageId, workspaceId } from '@hq/kernel'
import type { SandboxProvider } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import type { Authentication } from '../auth/session-tokens.ts'

type Segment = { first: AgentEvent; last: AgentEvent; text: string; isReasoning: boolean }
type StreamFrame = { type?: unknown; token?: unknown; chatId?: unknown }

const readyTimeoutMilliseconds = 5000
const visibleRetryMilliseconds = 100
const keyOf = (chat: AgentChat) => `${chat.workspaceId}/${chat.chatId}`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'an unknown error')

export const createAgentBridge = ({
  sandboxProvider,
  llm,
  sessionClassifierOf,
  now,
  resumeAfterMilliseconds,
  hqAgentImage,
  reopenDelayMilliseconds = 1000,
}: {
  sandboxProvider: SandboxProvider
  llm?: AgentLlm
  sessionClassifierOf?: (database: Database) => SessionClassifier
  now?: () => number
  resumeAfterMilliseconds?: number
  hqAgentImage?: string
  reopenDelayMilliseconds?: number
}) => {
  const bridgeOf = (database: Database) => {
    const sockets = new Map<
      string,
      {
        conversationId: string
        promptId: string | null
        streamedText: string
        segment?: Segment
        isReasoning: boolean
        isDraining: boolean
        endedPromptId: string | null
        isReady: Promise<void>
        questions: Map<string, object>
        close(): void
      }
    >()
    const streamedSeqs = new Map<string, number>()
    const viewers = new Map<string, Set<WSContext>>()
    const send = (viewer: WSContext, chat: AgentChat, frame: object) =>
      viewer.send(JSON.stringify({ chatId: chat.chatId, ...frame }))
    const handlers = createAgentHandlers({
      transact: (work) => zeroDrizzle(schema, database).transaction(work),
      sandboxProvider,
      llm,
      classifier: sessionClassifierOf?.(database),
      now,
      resumeAfterMilliseconds,
      hqAgentImage,
      eventSockets: {
        ensureOpen: (...target) => ensureOpen(...target),
        stopStreaming: (chat, promptId) => {
          const socket = sockets.get(keyOf(chat))
          if (socket?.promptId === promptId)
            Object.assign(socket, {
              promptId: null,
              streamedText: '',
              segment: undefined,
              isDraining: socket.endedPromptId !== promptId,
            })
        },
      },
    })
    let isReleased = false
    const logFailure = (chat: AgentChat) => (error: unknown) =>
      console.error(`Reopening the agent turn of chat ${chat.chatId} failed: ${messageOf(error)}`)
    const reopenLater = (chat: AgentChat) => setTimeout(() => void reopen(chat), reopenDelayMilliseconds)
    const reopen = async (chat: AgentChat) => {
      if (isReleased || sockets.has(keyOf(chat))) return
      const target = await handlers.reopenTarget(chat).catch((error) => {
        logFailure(chat)(error)
        reopenLater(chat)
        return undefined
      })
      if (!target) return
      await ensureOpen(chat, target.conversation, target.promptId)
      const { promptId, outcome } = target
      if (outcome)
        setTimeout(
          () => void handlers.closeReopenedTurn(chat, promptId, outcome).catch(logFailure(chat)),
          reopenDelayMilliseconds,
        )
    }
    const ensureOpen = (chat: AgentChat, conversation: AgentConversation, promptId: MessageId | null) => {
      const current = sockets.get(keyOf(chat))
      if (current?.conversationId === conversation.conversationId) {
        if (promptId && current.promptId !== promptId)
          Object.assign(current, { promptId, streamedText: '', segment: undefined })
        return current.isReady
      }
      current?.close()
      const ready = Promise.withResolvers<void>()
      let recording: Promise<unknown> = Promise.resolve()
      const chatSocket = {
        conversationId: conversation.conversationId,
        isReady: Promise.race([ready.promise, Bun.sleep(readyTimeoutMilliseconds)]),
        promptId: promptId as string | null,
        streamedText: '',
        segment: undefined as Segment | undefined,
        isReasoning: false,
        isDraining: false,
        endedPromptId: null as string | null,
        isClosed: false,
        questions: new Map<string, object>(),
        close: () => {
          chatSocket.isClosed = true
          opened.then(
            (socket) => socket.close(),
            () => {},
          )
        },
      }
      const closed = () => {
        ready.resolve()
        if (chatSocket.isClosed || sockets.get(keyOf(chat)) !== chatSocket) return
        sockets.delete(keyOf(chat))
        if (chatSocket.promptId) reopenLater(chat)
      }
      sockets.set(keyOf(chat), chatSocket)
      const record = (event: AgentEvent) => {
        const promptAtEvent = chatSocket.promptId
        recording = recording
          .then(() => handlers.recordEvent(chat, event))
          .then((recorded) => {
            if (recorded?.isReplyStored && promptAtEvent)
              for (const viewer of viewers.get(keyOf(chat)) ?? [])
                send(viewer, chat, { promptId: promptAtEvent, storedId: event.id })
            if (!recorded || chatSocket.promptId !== promptAtEvent) return
            chatSocket.promptId = recorded.promptId
            if (recorded.promptId === null) chatSocket.streamedText = ''
          })
          .catch((error) =>
            console.error(`Recording an agent event of chat ${chat.chatId} failed: ${messageOf(error)}`),
          )
      }
      const flushSegment = (boundary: AgentEvent) => {
        const { segment } = chatSocket
        if (!segment) return
        chatSocket.segment = undefined
        chatSocket.streamedText = ''
        const { first, last, text, isReasoning } = segment
        record({
          id: `${last.id}${isReasoning ? '-thought' : '-text'}`,
          kind: 'ACPUpdate',
          seq: last.seq,
          timestamp: last.timestamp,
          completed: true,
          update: {
            sessionUpdate: isReasoning ? 'agent_thought' : 'agent_message',
            text,
            durationMilliseconds: Date.parse(boundary.timestamp) - Date.parse(first.timestamp),
          },
        })
      }
      const opened = handlers.openEvents(chat, conversation, {
        onEvent: (event) => {
          ready.resolve()
          if (chatSocket.isClosed) return
          const streamed = streamedTextOf(event)
          const update = event.update as { sessionUpdate?: string; questionId?: string } | undefined
          if (update?.sessionUpdate === 'question') {
            chatSocket.questions.set(String(update.questionId), update)
            for (const viewer of viewers.get(keyOf(chat)) ?? [])
              send(viewer, chat, { promptId: chatSocket.promptId, question: update })
            return
          }
          if (update?.sessionUpdate === 'question_answered' || update?.sessionUpdate === 'question_closed')
            chatSocket.questions.delete(String(update.questionId))
          if (update?.sessionUpdate === 'turn_end') {
            if (chatSocket.isDraining) chatSocket.isDraining = false
            else chatSocket.endedPromptId = chatSocket.promptId
          }
          if (streamed && chatSocket.isDraining) return
          if (streamed?.text && chatSocket.promptId) {
            const { text, isReasoning } = streamed
            if (chatSocket.segment && chatSocket.segment.isReasoning !== isReasoning) flushSegment(event)
            chatSocket.segment = {
              first: chatSocket.segment?.first ?? event,
              last: event,
              text: (chatSocket.segment?.text ?? '') + text,
              isReasoning,
            }
            chatSocket.streamedText = (chatSocket.isReasoning === isReasoning ? chatSocket.streamedText : '') + text
            chatSocket.isReasoning = isReasoning
            const seq = Number(event.seq)
            if (seq > (streamedSeqs.get(conversation.conversationId) ?? 0)) {
              streamedSeqs.set(conversation.conversationId, seq)
              for (const viewer of viewers.get(keyOf(chat)) ?? [])
                send(viewer, chat, { promptId: chatSocket.promptId, text, ...(isReasoning && { isReasoning }) })
            }
          }
          if (streamed) return
          if (isStoredAgentEvent(event)) flushSegment(event)
          record(event)
        },
        onClose: closed,
      })
      opened.catch(closed)
      return chatSocket.isReady
    }
    return {
      jobs: handlers.jobs,
      ensureOpen,
      promptWaiting: handlers.promptWaiting,
      modelCallTurn: handlers.modelCallTurn,
      toolCallTurn: handlers.toolCallTurn,
      delegate: handlers.delegate,
      answerQuestion: handlers.answerQuestion,
      setPlanMode: handlers.setPlanMode,
      recordModelCallFailure: handlers.recordModelCallFailure,
      resumeActiveTurns: async () => {
        const chats = await database.$client<{ workspaceId: string; chatId: string }[]>`
          select workspace_id as "workspaceId", id as "chatId" from chats where agent_turn_message_id is not null`
        for (const chat of chats)
          await reopen({ workspaceId: workspaceId(chat.workspaceId), chatId: chatId(chat.chatId) })
      },
      watch: async (viewer: WSContext, context: ZeroContext, chat: AgentChat) => {
        const isVisible = async () =>
          (
            await database.$client`
              select 1 from chats join memberships on memberships.workspace_id = chats.workspace_id and memberships.user_id = ${context.userId}
              where chats.workspace_id = ${chat.workspaceId} and chats.id = ${chat.chatId}`
          ).length > 0
        for (let waited = 0; !(await isVisible()); waited += visibleRetryMilliseconds) {
          if (waited >= readyTimeoutMilliseconds) return
          await Bun.sleep(visibleRetryMilliseconds)
        }
        viewers.set(keyOf(chat), (viewers.get(keyOf(chat)) ?? new Set()).add(viewer))
        const streaming = sockets.get(keyOf(chat))
        if (streaming?.promptId && streaming.streamedText)
          send(viewer, chat, {
            promptId: streaming.promptId,
            text: streaming.streamedText,
            isSnapshot: true,
            ...(streaming.isReasoning && { isReasoning: true }),
          })
        for (const question of streaming?.questions.values() ?? [])
          send(viewer, chat, { promptId: streaming?.promptId, question, isSnapshot: true })
      },
      unwatch: (viewer: WSContext, chat?: AgentChat) => {
        for (const watching of chat ? [viewers.get(keyOf(chat))] : viewers.values()) watching?.delete(viewer)
      },
      release: () => {
        isReleased = true
        for (const socket of sockets.values()) socket.close()
        sockets.clear()
      },
    }
  }
  const bridges = new Map<Database, ReturnType<typeof bridgeOf>>()
  const forDatabase = (database: Database) => {
    const bridge = bridges.get(database) ?? bridgeOf(database)
    bridges.set(database, bridge)
    return bridge
  }
  return {
    forDatabase,
    release: (database: Database) => {
      bridges.get(database)?.release()
      bridges.delete(database)
    },
    stream: (
      authenticate: (authorization: string | undefined) => Promise<Authentication>,
      databaseOf: (databaseName: string | undefined) => Database | undefined,
    ) =>
      upgradeWebSocket(() => {
        let viewing: { context: ZeroContext; bridge: ReturnType<typeof bridgeOf> } | undefined
        let receiving = Promise.resolve()
        const receive = async (frame: StreamFrame, socket: WSContext) => {
          if (!viewing) {
            const authentication =
              frame.type === 'auth' && typeof frame.token === 'string'
                ? await authenticate(`Bearer ${frame.token}`)
                : undefined
            const database = authentication?.status === 200 ? databaseOf(authentication.databaseName) : undefined
            if (authentication?.status !== 200 || !database) return socket.close(4001, 'Not signed in')
            viewing = { context: authentication.context, bridge: forDatabase(database) }
            return
          }
          if (typeof frame.chatId !== 'string') return
          const chat = { workspaceId: viewing.context.workspaceId, chatId: chatId(frame.chatId) }
          if (frame.type === 'subscribe') await viewing.bridge.watch(socket, viewing.context, chat)
          if (frame.type === 'unsubscribe') viewing.bridge.unwatch(socket, chat)
        }
        return {
          onMessage: (event, socket) => {
            receiving = receiving
              .then(() => receive(JSON.parse(String(event.data)), socket))
              .catch((error) => {
                console.error(`An agent stream failed: ${messageOf(error)}`)
                socket.close(1011, 'Internal error')
              })
          },
          onClose: (_, socket) => viewing?.bridge.unwatch(socket),
        }
      }),
  }
}

export type AgentBridge = ReturnType<typeof createAgentBridge>
