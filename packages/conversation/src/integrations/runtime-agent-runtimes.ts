import type { Transaction } from '@rocicorp/zero'
import type { Transact } from '@spyria/db/zero-queries'
import {
  createRuntimeTransactor,
  ensureRuntimeRunning,
  expireSignIn,
  findLlmTokenChat,
  forgetAgentConversation,
  isRuntimeWaitingOnHost,
  issueAgentLlmToken,
  keepWorkspaceSnapshot,
  listHostChats,
  type RuntimePlacement,
  readAgentAccess,
  readWorkspaceSnapshot,
  rememberAgentConversation,
  retryRuntime,
  type SandboxProvider,
  touchRuntime,
} from '@spyria/runtime/published'
import type { AgentChat, AgentEndpoint, AgentRuntimes, RuntimeRetrier } from '../contracts/agent.ts'

export type { SandboxProvider }

export const createRuntimeAgentRuntimes = (
  transact: Transact,
  provider: SandboxProvider,
  placement: RuntimePlacement = {},
): AgentRuntimes => {
  const inTransaction = <Result>(
    work: (dependencies: { transactor: ReturnType<typeof createRuntimeTransactor> }) => Promise<Result>,
  ) => transact((tx) => work({ transactor: createRuntimeTransactor(tx) }))
  const accessOf = (chat: AgentChat) => inTransaction((dependencies) => readAgentAccess(dependencies, chat))
  const endpointFrom = ({ sandbox, apiKey, conversationId }: NonNullable<Awaited<ReturnType<typeof accessOf>>>) => ({
    sandbox,
    apiKey,
    conversationId,
    transport: provider.connect(sandbox),
  })
  const endpointOf = async (chat: AgentChat): Promise<AgentEndpoint | undefined> => {
    const access = await accessOf(chat)
    return access && endpointFrom(access)
  }
  return {
    ensureRunning: async (chat) => {
      const runtime = await inTransaction((dependencies) =>
        ensureRuntimeRunning({ ...dependencies, ...placement }, { ...chat, id: crypto.randomUUID(), now: Date.now() }),
      )
      if (['creating', 'starting', 'installing', 'stopping', 'removing'].includes(runtime.state))
        return { state: 'starting' }
      if (!runtime.hostOnline && ['running', 'stopped'].includes(runtime.state)) return { state: 'host_offline' }
      const access = runtime.state === 'running' ? await accessOf(chat) : undefined
      return access
        ? { state: 'ready', endpoint: endpointFrom(access), signedIn: access.signedIn }
        : { state: 'failed', failure: runtime.failure }
    },
    endpointOf,
    isWaitingOnHost: (chat) => inTransaction((dependencies) => isRuntimeWaitingOnHost(dependencies, chat)),
    rememberConversation: (chat, conversationId) =>
      inTransaction((dependencies) => rememberAgentConversation(dependencies, { ...chat, conversationId })),
    forgetConversation: (chat) => inTransaction((dependencies) => forgetAgentConversation(dependencies, chat)),
    issueLlmToken: (chat) => inTransaction((dependencies) => issueAgentLlmToken(dependencies, chat)),
    chatOfLlmToken: (host, token) =>
      inTransaction((dependencies) => findLlmTokenChat(dependencies, { ...host, token })),
    chatsOnHost: (host) => inTransaction((dependencies) => listHostChats(dependencies, host)),
    touch: (chat) => inTransaction((dependencies) => touchRuntime(dependencies, { ...chat, now: Date.now() })),
    expireSignIn: (chat, tool) => inTransaction((dependencies) => expireSignIn(dependencies, { ...chat, tool })),
    snapshotOf: (chat) => inTransaction((dependencies) => readWorkspaceSnapshot(dependencies, chat)),
    keepSnapshot: (chat, snapshot) =>
      inTransaction((dependencies) => keepWorkspaceSnapshot(dependencies, { ...chat, snapshot })),
  }
}

export const createZeroRuntimeRetrier = (tx: Transaction, placement: RuntimePlacement): RuntimeRetrier => ({
  retry: async (chat) => {
    await retryRuntime(
      { transactor: createRuntimeTransactor(tx), ...placement },
      { ...chat, id: crypto.randomUUID(), now: Date.now() },
    )
  },
})
