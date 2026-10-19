import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  type AgentChat,
  type AgentConversation,
  type AgentEvent,
  type AgentHost,
  type AgentLlm,
  createAgentHandlers,
  type DelegatedFrame,
  isApprovalQuestion,
  isAuthRequiredError,
  isStoredAgentEvent,
  type QuestionFrame,
  type RepositoryCheckouts,
  type SessionClassifier,
  streamedTextOf,
  toolCallIdOf,
} from '@spyria/conversation/server'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { chatPermissionsOf, type Transact, type ZeroContext, zql } from '@spyria/db/zero-queries'
import { can, chatId, type MemberId, type MessageId, workspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '@spyria/runtime/server'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import type { Authentication } from '../auth/session-tokens.ts'

type Segment = { first: AgentEvent; last: AgentEvent; text: string; isReasoning: boolean }
type StreamFrame = { type?: unknown; token?: unknown; chatId?: unknown }

const readyTimeoutMilliseconds = 5000
const readableRetryMilliseconds = 100
const keyOf = (chat: AgentChat) => `${chat.workspaceId}/${chat.chatId}`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'an unknown error')

export const createAgentBridge = ({
  sandboxProvider,
  llm,
  sessionClassifierOf,
  now,
  resumeAfterMilliseconds,
  approvalWindowMilliseconds,
  spyriaAgentImage,
  reopenDelayMilliseconds = 1000,
  repositoryCheckoutsOf,
}: {
  sandboxProvider: SandboxProvider
  llm?: AgentLlm
  sessionClassifierOf?: (database: Database) => SessionClassifier
  now?: () => number
  resumeAfterMilliseconds?: number
  approvalWindowMilliseconds?: number
  spyriaAgentImage?: string
  reopenDelayMilliseconds?: number
  repositoryCheckoutsOf?: (database: Database) => RepositoryCheckouts
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
        drainingPromptId: MessageId | null
        endedPromptId: string | null
        isReady: Promise<void>
        questions: Map<string, object>
        workspace?: object
        commandOutputs: Map<string, string>
        close(): void
      }
    >()
    const streamedSeqs = new Map<string, number>()
    const viewers = new Map<string, Map<WSContext, MemberId>>()
    const viewersOf = (chat: AgentChat) => viewers.get(keyOf(chat))?.keys() ?? []
    const delegatedTexts = new Map<string, Map<string, DelegatedFrame>>()
    const shownQuestions = new Map<string, Map<string, QuestionFrame>>()
    const send = (viewer: WSContext, chat: AgentChat, frame: object) =>
      viewer.send(JSON.stringify({ chatId: chat.chatId, ...frame }))
    const transact: Transact = (work) => zeroDrizzle(schema, database).transaction(work)
    const handlers = createAgentHandlers({
      transact,
      sandboxProvider,
      llm,
      classifier: sessionClassifierOf?.(database),
      now,
      resumeAfterMilliseconds,
      approvalWindowMilliseconds,
      spyriaAgentImage,
      checkouts: repositoryCheckoutsOf?.(database),
      eventSockets: {
        showQuestion: (chat, frame) => {
          shownQuestions.set(
            keyOf(chat),
            (shownQuestions.get(keyOf(chat)) ?? new Map()).set(frame.question.questionId, frame),
          )
          for (const viewer of viewersOf(chat)) send(viewer, chat, frame)
        },
        hideQuestion: (chat, questionId) => shownQuestions.get(keyOf(chat))?.delete(questionId),
        ensureOpen: (...target) => ensureOpen(...target),
        streamDelegated: (chat, frame) => {
          const texts = delegatedTexts.get(keyOf(chat)) ?? new Map<string, DelegatedFrame>()
          const previous = texts.get(frame.delegationId)
          const continues = previous && Boolean(previous.isReasoning) === Boolean(frame.isReasoning)
          if (frame.text === '') texts.delete(frame.delegationId)
          else texts.set(frame.delegationId, { ...frame, text: (continues ? previous.text : '') + frame.text })
          delegatedTexts.set(keyOf(chat), texts)
          for (const viewer of viewersOf(chat)) send(viewer, chat, frame)
        },
        stopStreaming: (chat, promptId) => {
          delegatedTexts.delete(keyOf(chat))
          const socket = sockets.get(keyOf(chat))
          if (socket?.promptId === promptId)
            Object.assign(socket, {
              promptId: null,
              streamedText: '',
              segment: undefined,
              drainingPromptId: socket.endedPromptId !== promptId ? promptId : null,
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
        drainingPromptId: null as MessageId | null,
        endedPromptId: null as string | null,
        isClosed: false,
        questions: new Map<string, object>(),
        workspace: undefined as object | undefined,
        commandOutputs: new Map<string, string>(),
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
      const record = (event: AgentEvent, turnPromptId?: MessageId) => {
        const promptAtEvent = chatSocket.promptId
        recording = recording
          .then(() => handlers.recordEvent(chat, event, turnPromptId))
          .then((recorded) => {
            if (recorded?.isReplyStored && (turnPromptId ?? promptAtEvent))
              for (const viewer of viewersOf(chat))
                send(viewer, chat, { promptId: turnPromptId ?? promptAtEvent, storedId: event.id })
            if (!recorded || chatSocket.promptId !== promptAtEvent) return
            chatSocket.promptId = recorded.promptId
            if (recorded.promptId !== null) return
            chatSocket.streamedText = ''
            delegatedTexts.delete(keyOf(chat))
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
          if (chatSocket.isClosed || isApprovalQuestion(event)) return
          const streamed = streamedTextOf(event)
          const update = event.update as { sessionUpdate?: string; questionId?: string } | undefined
          if (update?.sessionUpdate === 'question') {
            chatSocket.questions.set(String(update.questionId), update)
            for (const viewer of viewersOf(chat))
              send(viewer, chat, { promptId: chatSocket.promptId, question: update })
            return
          }
          if (update?.sessionUpdate === 'workspace') {
            chatSocket.workspace = update
            for (const viewer of viewersOf(chat)) send(viewer, chat, { workspace: update })
            return
          }
          const stepId = update?.sessionUpdate === 'tool_call_update' ? toolCallIdOf(event) : undefined
          const output = (update as { rawOutput?: { formatted_output?: unknown } } | undefined)?.rawOutput
            ?.formatted_output
          if (stepId && event.completed) chatSocket.commandOutputs.delete(stepId)
          if (stepId && !event.completed && typeof output === 'string') {
            chatSocket.commandOutputs.set(stepId, output)
            for (const viewer of viewersOf(chat)) send(viewer, chat, { commandOutput: { stepId, output } })
            return
          }
          if (update?.sessionUpdate === 'question_answered' || update?.sessionUpdate === 'question_closed')
            chatSocket.questions.delete(String(update.questionId))
          const drainedPromptId = chatSocket.drainingPromptId ?? undefined
          if (update?.sessionUpdate === 'turn_end') {
            if (drainedPromptId) chatSocket.drainingPromptId = null
            else chatSocket.endedPromptId = chatSocket.promptId
          }
          if (streamed && drainedPromptId) return
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
              for (const viewer of viewersOf(chat))
                send(viewer, chat, { promptId: chatSocket.promptId, text, ...(isReasoning && { isReasoning }) })
            }
          }
          if (streamed) return
          if (isAuthRequiredError(event)) Object.assign(chatSocket, { segment: undefined, streamedText: '' })
          if (isStoredAgentEvent(event)) flushSegment(event)
          record(event, drainedPromptId)
        },
        onClose: closed,
      })
      opened.catch(closed)
      return chatSocket.isReady
    }
    const isReadableBy = (memberId: MemberId, chat: AgentChat) =>
      transact(async (tx) => {
        const isMember = await tx.run(
          zql.memberships
            .where('workspaceId', chat.workspaceId)
            .where('userId', memberId)
            .where('removedAt', 'IS', null)
            .one(),
        )
        return (
          isMember !== undefined &&
          can(await chatPermissionsOf(tx, chat.workspaceId).permissions(chat.chatId, memberId), 'chat.read')
        )
      })
    const isStored = (chat: AgentChat) =>
      transact(
        async (tx) =>
          (await tx.run(zql.chats.where('workspaceId', chat.workspaceId).where('id', chat.chatId).one())) !== undefined,
      )
    const resumeActiveTurns = async () => {
      const chats = await database.$client<{ workspaceId: string; chatId: string }[]>`
        select workspace_id as "workspaceId", id as "chatId" from chats where agent_turn_message_id is not null`
      for (const chat of chats)
        await reopen({ workspaceId: workspaceId(chat.workspaceId), chatId: chatId(chat.chatId) })
    }
    return {
      jobs: handlers.jobs,
      ensureOpen,
      modelCallTurn: handlers.modelCallTurn,
      toolCallTurn: handlers.toolCallTurn,
      delegate: handlers.delegate,
      awaitTask: handlers.awaitTask,
      answerQuestion: handlers.answerQuestion,
      setPlanMode: handlers.setPlanMode,
      readWorkspace: handlers.readWorkspace,
      publishBranch: handlers.publishBranch,
      runGitAction: handlers.runGitAction,
      recordPullRequest: handlers.recordPullRequest,
      wakeWorkspace: handlers.wakeWorkspace,
      recordModelCallFailure: handlers.recordModelCallFailure,
      recordToolCall: handlers.recordToolCall,
      authorizeToolCall: handlers.authorizeToolCall,
      resumeHost: async (host: AgentHost) => {
        await resumeActiveTurns()
        return handlers.promptWaiting(host)
      },
      resumeActiveTurns,
      watch: async (viewer: WSContext, context: ZeroContext, chat: AgentChat) => {
        for (let waited = 0; !(await isReadableBy(context.userId, chat)); waited += readableRetryMilliseconds) {
          if (
            waited >= readyTimeoutMilliseconds ||
            ((await isStored(chat)) && !(await isReadableBy(context.userId, chat)))
          )
            return
          await Bun.sleep(readableRetryMilliseconds)
        }
        if (viewer.readyState !== 1) return
        viewers.set(keyOf(chat), (viewers.get(keyOf(chat)) ?? new Map()).set(viewer, context.userId))
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
        if (streaming?.workspace) send(viewer, chat, { workspace: streaming.workspace, isSnapshot: true })
        for (const [stepId, output] of streaming?.commandOutputs ?? [])
          send(viewer, chat, { commandOutput: { stepId, output }, isSnapshot: true })
        for (const frame of [
          ...(delegatedTexts.get(keyOf(chat))?.values() ?? []),
          ...(shownQuestions.get(keyOf(chat))?.values() ?? []),
        ])
          send(viewer, chat, { ...frame, isSnapshot: true })
        send(viewer, chat, { subscribed: true })
      },
      revokeUnreadable: async (chat: AgentChat) => {
        for (const [viewer, memberId] of viewers.get(keyOf(chat)) ?? [])
          if (!(await isReadableBy(memberId, chat))) viewers.get(keyOf(chat))?.delete(viewer)
      },
      closeMemberStreams: (workspaceId: string, memberId: string) => {
        for (const [key, watching] of viewers)
          if (key.startsWith(`${workspaceId}/`))
            for (const [viewer, viewerId] of watching) if (viewerId === memberId) viewer.close(4001, 'Not signed in')
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
        let connection: WSContext | undefined
        return {
          onMessage: (event, socket) => {
            connection ??= socket
            const viewer = connection
            receiving = receiving
              .then(() => receive(JSON.parse(String(event.data)), viewer))
              .catch((error) => {
                console.error(`An agent stream failed: ${messageOf(error)}`)
                viewer.close(1011, 'Internal error')
              })
          },
          onClose: () => {
            receiving = receiving.then(() => connection && viewing?.bridge.unwatch(connection))
          },
        }
      }),
  }
}

export type AgentBridge = ReturnType<typeof createAgentBridge>
