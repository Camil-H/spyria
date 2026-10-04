import { createContext, type ReactNode, use } from 'react'
import type { ConversationCommands } from './commands.ts'

const ConversationCommandsContext = createContext<ConversationCommands | null>(null)

export const ConversationProvider = ({
  commands,
  children,
}: {
  commands: ConversationCommands
  children: ReactNode
}) => <ConversationCommandsContext value={commands}>{children}</ConversationCommandsContext>

export const useConversationCommands = () => {
  const commands = use(ConversationCommandsContext)
  if (!commands) throw new Error('ConversationProvider is missing')
  return commands
}
