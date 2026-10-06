import {
  type AgentChat,
  type AgentConversation,
  type AgentHost,
  type AgentLlm,
  createAgentHandlers,
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

type StreamFrame = { type?: unknown; token?: unknown; chatId?: unknown }

const reopenDelayMilliseconds = 1000
const catchUpMilliseconds = 1000
const readyTimeoutMilliseconds = 5000
const keyOf = (chat: AgentChat) => `${chat.workspaceId}/${chat.chatId}`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'an unknown error')

export const createAgentBridge = ({
  sandboxProvider,
  llm,
  now,
}: {
  sandboxProvider: SandboxProvider
  llm: AgentLlm
  now?: () => number
}) => {
  const bridgeOf = (database: Database) => {
    const sockets = new Map<
      string,
      { conversationId: string; promptId: string | null; streamedText: string; isReady: Promise<void>; close(): void }
    >()
    const viewers = new Map<string, Set<WSContext>>()
    const send = (viewer: WSContext, chat: AgentChat, frame: object) =>
      viewer.send(JSON.stringify({ chatId: chat.chatId, ...frame }))
    const handlers = createAgentHandlers({
      transact: (work) => zeroDrizzle(schema, database).transaction(work),
      sandboxProvider,
      llm,
      now,
      eventSockets: {
        ensureOpen: (...target) => ensureOpen(...target),
        stopStreaming: (chat, promptId) => {
          const socket = sockets.get(keyOf(chat))
          if (socket?.promptId === promptId) Object.assign(socket, { promptId: null, streamedText: '' })
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
          catchUpMilliseconds,
        )
    }
    const ensureOpen = (chat: AgentChat, conversation: AgentConversation, promptId: MessageId) => {
      const current = sockets.get(keyOf(chat))
      if (current?.conversationId === conversation.conversationId) {
        if (current.promptId !== promptId) Object.assign(current, { promptId, streamedText: '' })
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
        isClosed: false,
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
      const opened = handlers.openEvents(chat, conversation, {
        onEvent: (event) => {
          ready.resolve()
          if (chatSocket.isClosed) return
          const text = streamedTextOf(event)
          if (text !== undefined && chatSocket.promptId) {
            chatSocket.streamedText += text
            for (const viewer of viewers.get(keyOf(chat)) ?? [])
              send(viewer, chat, { promptId: chatSocket.promptId, text })
          }
          if (text !== undefined) return
          const promptAtEvent = chatSocket.promptId
          recording = recording
            .then(() => handlers.recordEvent(chat, event))
            .then((recorded) => {
              if (!recorded || chatSocket.promptId !== promptAtEvent) return
              chatSocket.promptId = recorded.promptId
              if (recorded.isReplyStored || recorded.promptId === null) chatSocket.streamedText = ''
            })
            .catch((error) =>
              console.error(`Recording an agent event of chat ${chat.chatId} failed: ${messageOf(error)}`),
            )
        },
        onClose: closed,
      })
      opened.catch(closed)
      return chatSocket.isReady
    }
    return {
      jobs: handlers.jobs,
      ensureOpen,
      promptWaiting: (host: AgentHost) => handlers.promptWaiting(host),
      resumeActiveTurns: async () => {
        const chats = await database.$client<{ workspaceId: string; chatId: string }[]>`
          select workspace_id as "workspaceId", id as "chatId" from chats where agent_turn_message_id is not null`
        for (const chat of chats)
          await reopen({ workspaceId: workspaceId(chat.workspaceId), chatId: chatId(chat.chatId) })
      },
      watch: async (viewer: WSContext, context: ZeroContext, chat: AgentChat) => {
        const [visible] = await database.$client`
          select 1 from chats join memberships on memberships.workspace_id = chats.workspace_id and memberships.user_id = ${context.userId}
          where chats.workspace_id = ${chat.workspaceId} and chats.id = ${chat.chatId}`
        if (!visible) return
        viewers.set(keyOf(chat), (viewers.get(keyOf(chat)) ?? new Set()).add(viewer))
        const streaming = sockets.get(keyOf(chat))
        if (streaming?.promptId && streaming.streamedText)
          send(viewer, chat, { promptId: streaming.promptId, text: streaming.streamedText, isSnapshot: true })
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
