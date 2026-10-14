import {
  createRuntimeTransactor,
  ensureRuntimeRunning,
  findLlmTokenChat,
  forgetAgentConversation,
  issueAgentLlmToken,
  listHostChats,
  type RuntimePlacement,
  readAgentAccess,
  rememberAgentConversation,
  retryRuntime,
  type SandboxProvider,
  touchRuntime,
} from '@hq/runtime/published'
import type { Transaction } from '@rocicorp/zero'
import type { AgentChat, AgentEndpoint, AgentRuntimes, RuntimeRetrier } from '../contracts/agent.ts'
import type { Transact } from './zero-transactor.ts'

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
  const endpointFrom = ({
    sandbox,
    apiKey,
    conversationId,
    isHqAgent,
  }: NonNullable<Awaited<ReturnType<typeof accessOf>>>) => ({
    sandbox,
    apiKey,
    conversationId,
    isHqAgent,
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
      if (['creating', 'starting', 'stopping', 'removing'].includes(runtime.state)) return { state: 'starting' }
      if (!runtime.hostOnline && ['running', 'stopped'].includes(runtime.state)) return { state: 'host_offline' }
      const access = runtime.state === 'running' ? await accessOf(chat) : undefined
      return access
        ? { state: 'ready', endpoint: endpointFrom(access), signedIn: access.signedIn }
        : { state: 'failed', failure: runtime.failure }
    },
    endpointOf,
    rememberConversation: (chat, conversationId) =>
      inTransaction((dependencies) => rememberAgentConversation(dependencies, { ...chat, conversationId })),
    forgetConversation: (chat) => inTransaction((dependencies) => forgetAgentConversation(dependencies, chat)),
    issueLlmToken: (chat, isForSwitch) =>
      inTransaction((dependencies) => issueAgentLlmToken(dependencies, { ...chat, isForSwitch })),
    chatOfLlmToken: (host, token) =>
      inTransaction((dependencies) => findLlmTokenChat(dependencies, { ...host, token })),
    chatsOnHost: (host) => inTransaction((dependencies) => listHostChats(dependencies, host)),
    touch: (chat) => inTransaction((dependencies) => touchRuntime(dependencies, { ...chat, now: Date.now() })),
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
