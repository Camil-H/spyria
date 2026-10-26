import {
  type AgentStream,
  type ConversationCommands,
  conversationMutators,
  createHttpChatCommands,
  createStoreDraftRepository,
  saveDraft,
} from '@spyria/conversation/server'
import { createZeroStore, type Store, type WorkspaceSession } from '@spyria/db/zero-store'
import { type ChatId, type MemberId, type WorkspaceId, workspaceId } from '@spyria/kernel'
import type { PanelCommands } from '@spyria/panel'
import {
  createHttpGitHubConnection,
  createHttpLlmCredentialAdder,
  createHttpToolConnections,
  createHttpWorkspaceConnections,
  type ProfileCommands,
  profileMutators,
} from '@spyria/profile/server'
import { createHttpRuntimeHostCommands, type RuntimeCommands, runtimeMutators } from '@spyria/runtime/server'
import type { Session } from '@spyria/session'
import {
  createHttpAuditLogCommands,
  createHttpBudgetCommands,
  createHttpSpendCommands,
  type UsageCommands,
} from '@spyria/usage/server'
import {
  createHttpGitHubCommands,
  createHttpSsoSettingsCommands,
  type WorkspaceCommands,
  workspaceMutators,
} from '@spyria/workspace/server'
import { logOut, openSession, renew, signInWithPopup } from './auth.ts'

const zeroCacheURL = new URL(import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848', location.origin).href
const testStack =
  import.meta.env.MODE === 'e2e'
    ? (window as Window & { spyriaTestStack?: { zeroCacheURL: string } }).spyriaTestStack
    : undefined

const workspaceLoadMilliseconds = 30_000
let storeCount = 0

type CommandInput = { workspaceId: WorkspaceId; [argument: string]: unknown }
type Mutator = (args: never) => Parameters<Store['mutate']>[1]

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationCommands: ConversationCommands
  agentStream: AgentStream
  panelCommands: PanelCommands
  profileCommands: ProfileCommands
  runtimeCommands: RuntimeCommands
  usageCommands: UsageCommands
}

const streamReconnectMilliseconds = 1000
const notSignedInCloseCode = 4001

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
    socket.onclose = async (event) => {
      if (socketByWorkspace.get(workspaceId) !== socket) return
      socketByWorkspace.delete(workspaceId)
      if (event.code === notSignedInCloseCode) await store.renewSession(workspaceId)
      if (listenersByWorkspace.get(workspaceId)?.size && store.signedInWorkspaceIds().has(workspaceId))
        setTimeout(reconnect, streamReconnectMilliseconds, workspaceId)
    }
  }
  const reconnect = (workspaceId: WorkspaceId) => {
    if (!socketByWorkspace.has(workspaceId)) connect(workspaceId)
  }
  store.onSessionRenewed((workspaceId) => sendTo(workspaceId, { type: 'auth', token: store.tokenOf(workspaceId) }))
  return {
    subscribe: (workspaceId, chatId, listener) => {
      const listenersByChat = listenersByWorkspace.get(workspaceId) ?? new Map<ChatId, Set<Listener>>()
      listenersByWorkspace.set(workspaceId, listenersByChat)
      const listeners = listenersByChat.get(chatId) ?? new Set()
      if (listeners.size === 0) sendTo(workspaceId, { type: 'subscribe', chatId })
      listenersByChat.set(chatId, listeners.add(listener))
      reconnect(workspaceId)
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
  deployment: string,
): Promise<Application | undefined> => {
  const store = createZeroStore({
    memberId,
    sessions,
    renew,
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators, ...profileMutators, ...runtimeMutators },
    draftStorage: localStorage,
  })
  storeCount++
  if (testStack) Object.assign(window, { spyriaZeroDiagnostics: () => ({ storeCount, ...store.diagnostics() }) })
  const isLoaded = await Promise.race([
    store.whenLoaded(defaultWorkspaceId).then(() => true),
    new Promise<false>((resolve) => setTimeout(resolve, workspaceLoadMilliseconds, false)),
  ])
  if (!isLoaded) {
    await store.close()
    return undefined
  }
  const mutate = async (mutator: Mutator, input: CommandInput) => {
    const id = crypto.randomUUID()
    const { confirmation } = await store.mutate(input.workspaceId, mutator({ ...input, id } as never))
    return { id, confirmation }
  }
  const mutateConfirmed = (mutator: Mutator) => async (input: CommandInput) => {
    const { id, confirmation } = await mutate(mutator, input)
    await confirmation
    return id
  }
  const mutateIntoNewChat = (mutator: Mutator) => async (input: CommandInput) => {
    const newChatId = crypto.randomUUID()
    await (await mutate(mutator, { ...input, chatId: newChatId })).confirmation
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
  const postAsMember = (workspaceId: WorkspaceId, path: string, body?: BodyInit) =>
    fetch(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${store.tokenOf(workspaceId)}`,
        'content-type': body instanceof Blob ? 'application/octet-stream' : 'application/json',
      },
      body,
    })
  const fetchAsMember = (workspaceId: WorkspaceId, path: string, method = 'GET') =>
    fetch(path, { method, headers: { authorization: `Bearer ${store.tokenOf(workspaceId)}` } })
  const toolConnections = createHttpToolConnections(fetchAsMember)
  const githubCommands = createHttpGitHubCommands(postAsMember, fetchAsMember)
  const whenChatSynced = (chatId: ChatId) =>
    new Promise<void>((resolve) => {
      const isSynced = () => store.read().chats.some(({ id }) => id === chatId)
      const unsubscribe = store.subscribe(() => {
        if (!isSynced()) return
        unsubscribe()
        resolve()
      })
      if (isSynced()) {
        unsubscribe()
        resolve()
      }
    })
  const conversationCommands = commandsOf<ConversationCommands>(conversationMutators.conversation, {
    saveDraft: (input) => saveDraft({ drafts }, { ...input, memberId }),
    ...createHttpChatCommands(postAsMember, fetchAsMember),
    connectTool: toolConnections.connectTool,
    startRuntimeFromMessage: mutateIntoNewChat(conversationMutators.conversation.startRuntimeFromMessage),
    forkChat: mutateIntoNewChat(conversationMutators.conversation.forkChat),
    sendMessage: mutateConfirmed(conversationMutators.conversation.sendMessage),
    inviteMember: mutateConfirmed(conversationMutators.conversation.inviteMember),
    changeMemberRole: mutateConfirmed(conversationMutators.conversation.changeMemberRole),
    removeMember: mutateConfirmed(conversationMutators.conversation.removeMember),
    joinChannel: mutateConfirmed(conversationMutators.conversation.joinChannel),
    leaveChat: mutateConfirmed(conversationMutators.conversation.leaveChat),
    retryAgent: mutateConfirmed(conversationMutators.conversation.retryAgent),
  })
  const agentStream = createAgentStream(store)
  return {
    store,
    session: {
      memberId,
      defaultWorkspaceId,
      deployment,
      signedInWorkspaceIds: store.signedInWorkspaceIds,
      subscribe: store.subscribe,
      signOut: async (workspaceId) => {
        await logOut(workspaceId).catch(console.error)
        await store.signOut(workspaceId)
      },
      signIn: async (workspaceId) => {
        if ((await signInWithPopup({ workspace: workspaceId })).status !== 'signed_in') return
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
      changeVisibility: mutateConfirmed(workspaceMutators.workspace.changeVisibility),
      inviteMember: mutateConfirmed(workspaceMutators.workspace.inviteMember),
      revokeInvite: mutateConfirmed(workspaceMutators.workspace.revokeInvite),
      changeMemberRole: mutateConfirmed(workspaceMutators.workspace.changeMemberRole),
      removeMember: mutateConfirmed(workspaceMutators.workspace.removeMember),
      transferChat: mutateConfirmed(workspaceMutators.workspace.transferChat),
      createChatRole: mutateConfirmed(workspaceMutators.workspace.createChatRole),
      updateChatRole: mutateConfirmed(workspaceMutators.workspace.updateChatRole),
      deleteChatRole: mutateConfirmed(workspaceMutators.workspace.deleteChatRole),
      createWorkspaceRole: mutateConfirmed(workspaceMutators.workspace.createWorkspaceRole),
      updateWorkspaceRole: mutateConfirmed(workspaceMutators.workspace.updateWorkspaceRole),
      deleteWorkspaceRole: mutateConfirmed(workspaceMutators.workspace.deleteWorkspaceRole),
      deleteWorkspace: async (input) => {
        await mutateConfirmed(workspaceMutators.workspace.deleteWorkspace)(input)
        await store.signOut(input.workspaceId)
        location.assign('/')
        return input.workspaceId
      },
      ...createHttpSsoSettingsCommands(postAsMember, fetchAsMember),
      ...githubCommands,
      createDevChat: async (input) => {
        const chatId = await githubCommands.createDevChat(input)
        await whenChatSynced(chatId)
        return chatId
      },
      joinChannel: mutateConfirmed(conversationMutators.conversation.joinChannel),
      leaveChat: mutateConfirmed(conversationMutators.conversation.leaveChat),
    }),
    conversationCommands,
    agentStream,
    panelCommands: conversationCommands,
    profileCommands: commandsOf<ProfileCommands>(profileMutators.profile, {
      addLlmCredential: createHttpLlmCredentialAdder(postAsMember),
      ...toolConnections,
      ...createHttpWorkspaceConnections(postAsMember),
      ...createHttpGitHubConnection(fetchAsMember),
    }),
    runtimeCommands: commandsOf<RuntimeCommands>(
      runtimeMutators.runtime,
      createHttpRuntimeHostCommands(postAsMember, fetchAsMember),
    ),
    usageCommands: {
      ...createHttpAuditLogCommands(postAsMember, fetchAsMember),
      ...createHttpSpendCommands(fetchAsMember),
      ...createHttpBudgetCommands(postAsMember, fetchAsMember),
    },
  }
}
