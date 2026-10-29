import { context, ROOT_CONTEXT, type Span, trace } from '@opentelemetry/api'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  type AgentChat,
  type AgentConversation,
  type AgentEvent,
  type AgentHost,
  type AgentLlm,
  agentJobTypes,
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
  turnEndPromptIdOf,
} from '@spyria/conversation/server'
import type { Database } from '@spyria/db/postgres'
import { schema } from '@spyria/db/zero'
import { chatPermissionsOf, type Transact, type ZeroContext, zql } from '@spyria/db/zero-queries'
import { can, chatId, log, type MemberId, type MessageId, messageId, workspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '@spyria/runtime/server'
import type { ServerWebSocket } from 'bun'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import type { Authentication } from '../auth/session-tokens.ts'

type Segment = { first: AgentEvent; last: AgentEvent; text: string; isReasoning: boolean }
type StreamFrame = { type?: unknown; token?: unknown; chatId?: unknown }

const readyTimeoutMilliseconds = 5000
const readableRetryMilliseconds = 100
const commandOutputIntervalMilliseconds = 100
const slowViewerBytes = 4 * 1024 * 1024
const slowViewerCloseCode = 4008
const notSignedInCloseCode = 4001
type StreamSession = { workspaceId: string; memberId: MemberId; sessionId: string }
const keyOf = (chat: AgentChat) => `${chat.workspaceId}/${chat.chatId}`
const turnKeyOf = (workspace: string, promptId: string) => `${workspace}/${promptId}`

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
  deployment,
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
  deployment?: string
}) => {
  const turnSpans = new Map<string, { span: Span; startedAt: number }>()
  const turnContextOf = (workspace: string, promptId: string) => {
    const turn = turnSpans.get(turnKeyOf(workspace, promptId))
    return turn ? trace.setSpan(ROOT_CONTEXT, turn.span) : ROOT_CONTEXT
  }
  const inTurn = async <Result>(
    workspace: string,
    promptId: string,
    work: () => Promise<Result>,
    isStreaming: () => boolean,
  ) => {
    const key = turnKeyOf(workspace, promptId)
    const turn = turnSpans.get(key) ?? {
      span: trace
        .getTracer('spyria')
        .startSpan('chat.turn', { attributes: { 'workspace.id': workspace, 'turn.id': promptId } }),
      startedAt: performance.now(),
    }
    turnSpans.set(key, turn)
    try {
      return await context.with(trace.setSpan(context.active(), turn.span), work)
    } finally {
      if (!isStreaming() && turnSpans.get(key) === turn) {
        turnSpans.delete(key)
        turn.span.end()
      }
    }
  }
  const endTurn = (chat: AgentChat, promptId: string) => {
    const turn = turnSpans.get(turnKeyOf(chat.workspaceId, promptId))
    if (!turn) return
    turnSpans.delete(turnKeyOf(chat.workspaceId, promptId))
    context.with(trace.setSpan(ROOT_CONTEXT, turn.span), () =>
      log.info({
        event: 'agent.turn',
        body: 'Agent turn ended',
        attributes: {
          'workspace.id': chat.workspaceId,
          'chat.id': chat.chatId,
          'turn.id': promptId,
          duration_ms: Math.round(performance.now() - turn.startedAt),
        },
      }),
    )
    turn.span.end()
  }
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
    const watchedKeys = new Map<WSContext, Set<string>>()
    const streams = new Map<WSContext, StreamSession>()
    const closeStreamsWhere = (isClosed: (session: StreamSession) => boolean) => {
      for (const [viewer, session] of streams)
        if (isClosed(session)) viewer.close(notSignedInCloseCode, 'Not signed in')
    }
    const viewersOf = (chat: AgentChat) => viewers.get(keyOf(chat))?.keys() ?? []
    const watchChat = (viewer: WSContext, key: string, memberId: MemberId) => {
      viewers.set(key, (viewers.get(key) ?? new Map()).set(viewer, memberId))
      watchedKeys.set(viewer, (watchedKeys.get(viewer) ?? new Set()).add(key))
    }
    const unwatchChat = (viewer: WSContext, key: string) => {
      const watching = viewers.get(key)
      watching?.delete(viewer)
      if (watching?.size === 0) viewers.delete(key)
      const watched = watchedKeys.get(viewer)
      watched?.delete(key)
      if (watched?.size === 0) watchedKeys.delete(viewer)
    }
    const unwatchEveryChat = (viewer: WSContext) => {
      for (const key of [...(watchedKeys.get(viewer) ?? [])]) unwatchChat(viewer, key)
    }
    const delegatedTexts = new Map<string, Map<string, DelegatedFrame>>()
    const shownQuestions = new Map<string, Map<string, QuestionFrame>>()
    const sendText = (viewer: WSContext, text: string) => {
      if (((viewer.raw as ServerWebSocket | undefined)?.getBufferedAmount() ?? 0) <= slowViewerBytes)
        return viewer.send(text)
      unwatchEveryChat(viewer)
      viewer.close(slowViewerCloseCode, 'Too slow; reconnect to catch up')
    }
    const frameTextOf = (chat: AgentChat, frame: object) => JSON.stringify({ chatId: chat.chatId, ...frame })
    const send = (viewer: WSContext, chat: AgentChat, frame: object) => sendText(viewer, frameTextOf(chat, frame))
    const broadcast = (chat: AgentChat, frame: object) => {
      const text = frameTextOf(chat, frame)
      for (const viewer of viewersOf(chat)) sendText(viewer, text)
    }
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
      deployment,
      eventSockets: {
        showQuestion: (chat, frame) => {
          shownQuestions.set(
            keyOf(chat),
            (shownQuestions.get(keyOf(chat)) ?? new Map()).set(frame.question.questionId, frame),
          )
          broadcast(chat, frame)
        },
        hideQuestion: (chat, questionId) => {
          const shown = shownQuestions.get(keyOf(chat))
          shown?.delete(questionId)
          if (shown?.size === 0) shownQuestions.delete(keyOf(chat))
        },
        ensureOpen: (...target) => ensureOpen(...target),
        streamDelegated: (chat, frame) => {
          const texts = delegatedTexts.get(keyOf(chat)) ?? new Map<string, DelegatedFrame>()
          const previous = texts.get(frame.delegationId)
          const continues = previous && Boolean(previous.isReasoning) === Boolean(frame.isReasoning)
          if (frame.text === '') texts.delete(frame.delegationId)
          else texts.set(frame.delegationId, { ...frame, text: (continues ? previous.text : '') + frame.text })
          if (texts.size === 0) delegatedTexts.delete(keyOf(chat))
          else delegatedTexts.set(keyOf(chat), texts)
          broadcast(chat, frame)
        },
        stopStreaming: (chat, promptId) => {
          endTurn(chat, promptId)
          delegatedTexts.delete(keyOf(chat))
          const socket = sockets.get(keyOf(chat))
          if (socket?.promptId !== promptId) return
          streamedSeqs.delete(socket.conversationId)
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
      log.error({
        event: 'agent.turn.reopen_failed',
        body: 'Reopening an agent turn failed',
        attributes: { 'workspace.id': chat.workspaceId, 'chat.id': chat.chatId },
        error,
      })
    const reopenLater = (chat: AgentChat, closedPromptId?: string) =>
      setTimeout(() => void reopen(chat, closedPromptId), reopenDelayMilliseconds)
    const reopen = async (chat: AgentChat, closedPromptId?: string) => {
      if (isReleased || sockets.has(keyOf(chat))) return
      const target = await handlers.reopenTarget(chat, closedPromptId).catch((error) => {
        logFailure(chat)(error)
        reopenLater(chat, closedPromptId)
        return null
      })
      if (target === null) return
      if (closedPromptId && target?.promptId !== closedPromptId) endTurn(chat, closedPromptId)
      if (!target || sockets.has(keyOf(chat))) return
      await ensureOpen(chat, target.conversation, target.promptId)
      const { promptId, outcome } = target
      if (outcome)
        setTimeout(
          () =>
            void handlers
              .closeReopenedTurn(chat, promptId, outcome)
              .then(() => endTurn(chat, promptId))
              .catch(logFailure(chat)),
          reopenDelayMilliseconds,
        )
    }
    const ensureOpen = (chat: AgentChat, conversation: AgentConversation, promptId: MessageId | null) => {
      const current = sockets.get(keyOf(chat))
      if (current?.conversationId === conversation.conversationId) {
        if (promptId && current.promptId !== promptId) {
          if (current.promptId) endTurn(chat, current.promptId)
          Object.assign(current, { promptId, streamedText: '', segment: undefined })
        }
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
        if (chatSocket.promptId) reopenLater(chat, chatSocket.promptId)
      }
      sockets.set(keyOf(chat), chatSocket)
      const record = (event: AgentEvent, turnPromptId?: MessageId) => {
        const promptAtEvent = chatSocket.promptId
        recording = recording
          .then(() => handlers.recordEvent(chat, event, turnPromptId))
          .then((recorded) => {
            if (recorded?.isReplyStored && (turnPromptId ?? promptAtEvent))
              broadcast(chat, { promptId: turnPromptId ?? promptAtEvent, storedId: event.id })
            if (!recorded || chatSocket.promptId !== promptAtEvent) return
            chatSocket.promptId = recorded.promptId
            if (recorded.promptId !== null) return
            if (promptAtEvent) endTurn(chat, promptAtEvent)
            streamedSeqs.delete(conversation.conversationId)
            chatSocket.streamedText = ''
            delegatedTexts.delete(keyOf(chat))
          })
          .catch((error) =>
            log.error({
              event: 'agent.event.record_failed',
              body: 'Recording an agent event failed',
              attributes: { 'workspace.id': chat.workspaceId, 'chat.id': chat.chatId },
              error,
            }),
          )
      }
      const unsentOutputs = new Set<string>()
      let outputTimer: ReturnType<typeof setTimeout> | undefined
      const flushOutputs = () => {
        for (const stepId of unsentOutputs) {
          const output = chatSocket.commandOutputs.get(stepId)
          if (output !== undefined) broadcast(chat, { commandOutput: { stepId, output } })
        }
        unsentOutputs.clear()
      }
      const showOutputs = () => {
        if (outputTimer) return
        flushOutputs()
        outputTimer = setTimeout(() => {
          outputTimer = undefined
          if (unsentOutputs.size > 0) showOutputs()
        }, commandOutputIntervalMilliseconds)
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
            broadcast(chat, { promptId: chatSocket.promptId, question: update })
            return
          }
          if (update?.sessionUpdate === 'workspace') {
            chatSocket.workspace = update
            broadcast(chat, { workspace: update })
            return
          }
          const stepId = update?.sessionUpdate === 'tool_call_update' ? toolCallIdOf(event) : undefined
          const output = (update as { rawOutput?: { formatted_output?: unknown } } | undefined)?.rawOutput
            ?.formatted_output
          if (stepId && event.completed) {
            flushOutputs()
            chatSocket.commandOutputs.delete(stepId)
          }
          if (stepId && !event.completed && typeof output === 'string') {
            chatSocket.commandOutputs.set(stepId, output)
            unsentOutputs.add(stepId)
            showOutputs()
            return
          }
          if (update?.sessionUpdate === 'question_answered' || update?.sessionUpdate === 'question_closed')
            chatSocket.questions.delete(String(update.questionId))
          const endedPromptId = turnEndPromptIdOf(event)
          if (endedPromptId && endedPromptId !== chatSocket.promptId && endedPromptId !== chatSocket.drainingPromptId)
            return record(event, messageId(endedPromptId))
          const drainedPromptId = chatSocket.drainingPromptId ?? undefined
          if (update?.sessionUpdate === 'turn_end') {
            flushOutputs()
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
              broadcast(chat, { promptId: chatSocket.promptId, text, ...(isReasoning && { isReasoning }) })
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
        select workspace_id as "workspaceId", id as "chatId" from chats join workspaces using (workspace_id)
        where agent_turn_message_id is not null and workspaces.deleted_at is null`
      for (const chat of chats)
        await reopen({ workspaceId: workspaceId(chat.workspaceId), chatId: chatId(chat.chatId) })
    }
    return {
      jobs: {
        ...handlers.jobs,
        [agentJobTypes.prompt]: (job: Parameters<(typeof handlers.jobs)[typeof agentJobTypes.prompt]>[0]) => {
          const promptId = String((job.payload as { messageId?: unknown }).messageId)
          return inTurn(
            job.workspaceId,
            promptId,
            () => handlers.jobs[agentJobTypes.prompt](job),
            () => [...sockets.values()].some((socket) => socket.promptId === promptId),
          )
        },
      },
      ensureOpen,
      modelCallTurn: handlers.modelCallTurn,
      toolCallTurn: handlers.toolCallTurn,
      webSearchModel: handlers.webSearchModel,
      delegate: handlers.delegate,
      awaitTask: handlers.awaitTask,
      checkTask: handlers.checkTask,
      answerQuestion: handlers.answerQuestion,
      readWorkspace: handlers.readWorkspace,
      readRuntimeMedia: handlers.readRuntimeMedia,
      publishBranch: handlers.publishBranch,
      callGitHubTool: handlers.callGitHubTool,
      callSpyriaTool: handlers.callSpyriaTool,
      runGitAction: handlers.runGitAction,
      recordPullRequest: handlers.recordPullRequest,
      wakeWorkspace: handlers.wakeWorkspace,
      recordModelCallFailure: handlers.recordModelCallFailure,
      recordContextSize: handlers.recordContextSize,
      recordToolCall: handlers.recordToolCall,
      authorizeToolCall: handlers.authorizeToolCall,
      resumeHost: async (host: AgentHost) => {
        await resumeActiveTurns()
        const [live] = await database.$client`
          select 1 from workspaces where workspace_id = ${host.workspaceId} and deleted_at is null`
        return live && handlers.promptWaiting(host)
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
        watchChat(viewer, keyOf(chat), context.userId)
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
          if (!(await isReadableBy(memberId, chat))) unwatchChat(viewer, keyOf(chat))
      },
      closeMemberStreams: (workspaceId: string, memberId: string) =>
        closeStreamsWhere((session) => session.workspaceId === workspaceId && session.memberId === memberId),
      closeSessionStreams: (workspaceId: string, sessionId: string) =>
        closeStreamsWhere((session) => session.workspaceId === workspaceId && session.sessionId === sessionId),
      closeWorkspaceStreams: (workspaceId: string) =>
        closeStreamsWhere((session) => session.workspaceId === workspaceId),
      openStream: (viewer: WSContext, session: StreamSession) => {
        streams.set(viewer, session)
      },
      unwatch: (viewer: WSContext, chat: AgentChat) => unwatchChat(viewer, keyOf(chat)),
      endStream: (viewer: WSContext) => {
        streams.delete(viewer)
        unwatchEveryChat(viewer)
      },
      retained: () => ({
        turnSpans: turnSpans.size,
        viewers: viewers.size,
        watchingViewers: watchedKeys.size,
        shownQuestions: shownQuestions.size,
        delegatedTexts: delegatedTexts.size,
        streamedSeqs: streamedSeqs.size,
      }),
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
    turnContextOf,
    release: (database: Database) => {
      bridges.get(database)?.release()
      bridges.delete(database)
    },
    stream: (
      authenticate: (authorization: string | undefined) => Promise<Authentication>,
      databaseOf: (databaseName: string | undefined) => Database | undefined,
    ) =>
      upgradeWebSocket(() => {
        let viewing: { context: ZeroContext; database: Database; bridge: ReturnType<typeof bridgeOf> } | undefined
        let receiving = Promise.resolve()
        let expiry: ReturnType<typeof setTimeout> | undefined
        const signIn = async (frame: StreamFrame, socket: WSContext) => {
          const authentication =
            frame.type === 'auth' && typeof frame.token === 'string'
              ? await authenticate(`Bearer ${frame.token}`)
              : undefined
          const database = authentication?.status === 200 ? databaseOf(authentication.databaseName) : undefined
          const isSameViewer =
            !viewing ||
            (authentication?.status === 200 &&
              database === viewing.database &&
              authentication.context.userId === viewing.context.userId &&
              authentication.context.workspaceId === viewing.context.workspaceId)
          clearTimeout(expiry)
          if (authentication?.status !== 200 || !database || !isSameViewer)
            return socket.close(notSignedInCloseCode, 'Not signed in')
          viewing ??= { context: authentication.context, database, bridge: forDatabase(database) }
          viewing.bridge.openStream(socket, {
            workspaceId: authentication.context.workspaceId,
            memberId: authentication.context.userId,
            sessionId: authentication.sessionId,
          })
          expiry = setTimeout(
            () => socket.close(notSignedInCloseCode, 'Not signed in'),
            authentication.expiresAt - Date.now(),
          )
        }
        const receive = async (frame: StreamFrame, socket: WSContext) => {
          if (frame.type === 'auth' || !viewing) return signIn(frame, socket)
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
                log.error({ event: 'agent.stream.failed', body: 'An agent stream failed', error })
                viewer.close(1011, 'Internal error')
              })
          },
          onClose: () => {
            clearTimeout(expiry)
            receiving = receiving.then(() => connection && viewing?.bridge.endStream(connection))
          },
        }
      }),
  }
}

export type AgentBridge = ReturnType<typeof createAgentBridge>
