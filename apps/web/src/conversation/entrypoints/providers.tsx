import { createContext, type ReactNode, use } from 'react'
import type { Clock } from '../contracts/clock.ts'
import type { IdGenerator } from '../contracts/id-generator.ts'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'

export type ConversationDependencies = {
  transactor: ConversationTransactor
  idGenerator: IdGenerator
  clock: Clock
  runtimeChatStarter: RuntimeChatStarter
}

const ConversationDependenciesContext = createContext<ConversationDependencies | null>(null)

export const ConversationProvider = ({
  dependencies,
  children,
}: {
  dependencies: ConversationDependencies
  children: ReactNode
}) => <ConversationDependenciesContext value={dependencies}>{children}</ConversationDependenciesContext>

export const useConversationDependencies = () => {
  const dependencies = use(ConversationDependenciesContext)
  if (!dependencies) throw new Error('ConversationProvider is missing')
  return dependencies
}
