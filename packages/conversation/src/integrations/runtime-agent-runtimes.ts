import {
  createRuntimeTransactor,
  ensureRuntimeRunning,
  readAgentAccess,
  rememberAgentConversation,
  type SandboxProvider,
  touchRuntime,
} from '@hq/runtime/published'
import type { AgentChat, AgentEndpoint, AgentRuntimes } from '../contracts/agent.ts'
import type { Transact } from './zero-transactor.ts'

export type { SandboxProvider }

export const createRuntimeAgentRuntimes = (transact: Transact, provider: SandboxProvider): AgentRuntimes => {
  const inTransaction = <Result>(
    work: (dependencies: { transactor: ReturnType<typeof createRuntimeTransactor> }) => Promise<Result>,
  ) => transact((tx) => work({ transactor: createRuntimeTransactor(tx) }))
  const endpointOf = async (chat: AgentChat): Promise<AgentEndpoint | undefined> => {
    const access = await inTransaction((dependencies) => readAgentAccess(dependencies, chat))
    return access && { ...access, transport: provider.connect(access.sandbox) }
  }
  return {
    ensureRunning: async (chat) => {
      const runtime = await inTransaction((dependencies) =>
        ensureRuntimeRunning(dependencies, { ...chat, id: crypto.randomUUID(), now: Date.now() }),
      )
      if (['creating', 'starting', 'stopping'].includes(runtime.state)) return { state: 'starting' }
      const endpoint = runtime.state === 'running' ? await endpointOf(chat) : undefined
      return endpoint ? { state: 'ready', endpoint } : { state: 'failed', failure: runtime.failure }
    },
    endpointOf,
    rememberConversation: (chat, conversationId) =>
      inTransaction((dependencies) => rememberAgentConversation(dependencies, { ...chat, conversationId })),
    touch: (chat) => inTransaction((dependencies) => touchRuntime(dependencies, { ...chat, now: Date.now() })),
  }
}
