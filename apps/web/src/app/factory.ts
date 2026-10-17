import {
  type AgentStream,
  type ConversationCommands,
  conversationMutators,
  createHttpChatCommands,
  createStoreDraftRepository,
  saveDraft,
} from '@hq/conversation/server'
import { createZeroStore, type Store, type WorkspaceSession } from '@hq/db/zero-store'
import { type ChatId, type MemberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import {
  createHttpLlmCredentialAdder,
  createHttpToolConnections,
  type ProfileCommands,
  profileMutators,
} from '@hq/profile/server'
import { createHttpRuntimeHostCommands, type RuntimeCommands, runtimeMutators } from '@hq/runtime/server'
import type { Session } from '@hq/session'
import { type WorkspaceCommands, workspaceMutators } from '@hq/workspace/server'
import { logOut, openSession, renew, signInWithPopup } from './auth.ts'

const zeroCacheURL = import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848'
const testStack =
  import.meta.env.MODE === 'e2e'
    ? (window as Window & { hqTestStack?: { zeroCacheURL: string } }).hqTestStack
    : undefined

type CommandInput = { workspaceId: WorkspaceId; [argument: string]: unknown }
type Mutator = (args: never) => Parameters<Store['mutate']>[1]

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationCommands: ConversationCommands
  agentStream: AgentStream
  profileCommands: ProfileCommands
  runtimeCommands: RuntimeCommands
}

const streamReconnectMilliseconds = 1000

const createAgentStream = (store: Store): AgentStream => {
  type Listener = Parameters<AgentStream['subscribe']>[2]
  const listenersByWorkspace = new Map<WorkspaceId, Map<ChatId, Set<Listener>>>()
  const socketByWorkspace = new Map<WorkspaceId, WebSocket>()
  const sendTo = (workspaceId: WorkspaceId, frame: object) => {
    const socket = socketByWorkspace.get(workspaceId)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }
  const connect = (workspaceId: WorkspaceId) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/stream`)
    socketByWorkspace.set(workspaceId, socket)
    socket.onopen = () => {
      sendTo(workspaceId, { type: 'auth', token: store.tokenOf(workspaceId) })
      for (const chatId of listenersByWorkspace.get(workspaceId)?.keys() ?? [])
        sendTo(workspaceId, { type: 'subscribe', chatId })
    }
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame.subscribed) return
      for (const listener of listenersByWorkspace.get(workspaceId)?.get(frame.chatId) ?? []) listener(frame)
    }
    socket.onclose = () => {
      if (socketByWorkspace.get(workspaceId) !== socket) return
      socketByWorkspace.delete(workspaceId)
      if (listenersByWorkspace.get(workspaceId)?.size)
        setTimeout(() => connect(workspaceId), streamReconnectMilliseconds)
    }
  }
  return {
    subscribe: (workspaceId, chatId, listener) => {
      const listenersByChat = listenersByWorkspace.get(workspaceId) ?? new Map<ChatId, Set<Listener>>()
      listenersByWorkspace.set(workspaceId, listenersByChat)
      const listeners = listenersByChat.get(chatId) ?? new Set()
      if (listeners.size === 0) sendTo(workspaceId, { type: 'subscribe', chatId })
      listenersByChat.set(chatId, listeners.add(listener))
      if (!socketByWorkspace.has(workspaceId)) connect(workspaceId)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        listenersByChat.delete(chatId)
        sendTo(workspaceId, { type: 'unsubscribe', chatId })
      }
    },
  }
}

export const createApp = async (
  memberId: MemberId,
  defaultWorkspaceId: WorkspaceId,
  sessions: readonly WorkspaceSession[],
): Promise<Application> => {
  const store = createZeroStore({
    memberId,
    sessions,
    renew,
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators, ...profileMutators, ...runtimeMutators },
    draftStorage: localStorage,
  })
  await store.whenLoaded(defaultWorkspaceId)
  const mutate = async (mutator: Mutator, input: CommandInput) => {
    const id = crypto.randomUUID()
    const { confirmation } = await store.mutate(input.workspaceId, mutator({ ...input, id } as never))
    return { id, confirmation }
  }
  const mutateIntoNewChat = (mutator: Mutator) => async (input: CommandInput) => {
    const newChatId = crypto.randomUUID()
    await mutate(mutator, { ...input, chatId: newChatId })
    return newChatId
  }
  const commandsOf = <Commands>(mutators: Record<string, Mutator>, overrides: Partial<Commands>) =>
    ({
      ...Object.fromEntries(
        Object.entries(mutators).map(([name, mutator]) => [
          name,
          async (input: CommandInput) => (await mutate(mutator, input)).id,
        ]),
      ),
      ...overrides,
    }) as Commands
  const drafts = createStoreDraftRepository(store)
  const postAsMember = (workspaceId: WorkspaceId, path: string, body?: string) =>
    fetch(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${store.tokenOf(workspaceId)}`, 'content-type': 'application/json' },
      body,
    })
  const fetchAsMember = (workspaceId: WorkspaceId, path: string, method = 'GET') =>
    fetch(path, { method, headers: { authorization: `Bearer ${store.tokenOf(workspaceId)}` } })
  const toolConnections = createHttpToolConnections(fetchAsMember)
  return {
    store,
    session: {
      memberId,
      defaultWorkspaceId,
      signedInWorkspaceIds: store.signedInWorkspaceIds,
      subscribe: store.subscribe,
      signOut: async (workspaceId) => {
        await logOut(workspaceId).catch(console.error)
        await store.signOut(workspaceId)
      },
      signIn: async (workspaceId) => {
        if ((await signInWithPopup(workspaceId)).status !== 'signed_in') return
        const session = await renew(workspaceId)
        if (session) await store.signIn(session)
      },
    },
    workspaceCommands: commandsOf<WorkspaceCommands>(workspaceMutators.workspace, {
      createWorkspace: async (input) => {
        const bearerToken = store.tokenOf(input.workspaceId)
        const { id, confirmation } = await mutate(workspaceMutators.workspace.createWorkspace, input)
        store.signInToNew(
          workspaceId(id),
          confirmation.then(() => openSession(workspaceId(id), bearerToken)),
        )
        return id
      },
      joinChannel: async (input) => (await mutate(conversationMutators.conversation.joinChannel, input)).id,
      leaveChat: async (input) => (await mutate(conversationMutators.conversation.leaveChat, input)).id,
    }),
    conversationCommands: commandsOf<ConversationCommands>(conversationMutators.conversation, {
      saveDraft: (input) => saveDraft({ drafts }, { ...input, memberId }),
      ...createHttpChatCommands(postAsMember, fetchAsMember),
      connectTool: toolConnections.connectTool,
      startRuntimeFromMessage: mutateIntoNewChat(conversationMutators.conversation.startRuntimeFromMessage),
      forkChat: mutateIntoNewChat(conversationMutators.conversation.forkChat),
      retryAgent: async (input) => {
        const { id, confirmation } = await mutate(conversationMutators.conversation.retryAgent, input)
        await confirmation
        return id
      },
    }),
    agentStream: createAgentStream(store),
    profileCommands: commandsOf<ProfileCommands>(profileMutators.profile, {
      addLlmCredential: createHttpLlmCredentialAdder(postAsMember),
      ...toolConnections,
    }),
    runtimeCommands: commandsOf<RuntimeCommands>(
      runtimeMutators.runtime,
      createHttpRuntimeHostCommands(postAsMember, fetchAsMember),
    ),
  }
}
