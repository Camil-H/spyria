import { createCommandsContext } from '@hq/ui'
import { createContext, type ReactNode } from 'react'
import type { AgentStream, ConversationCommands } from './commands.ts'
import type { QuestionAnswer } from './endpoints.ts'

const [CommandsProvider, useConversationCommands] = createCommandsContext<ConversationCommands>('ConversationProvider')
const [AgentStreamProvider, useAgentStream] = createCommandsContext<AgentStream>('ConversationProvider')

export { useAgentStream, useConversationCommands }

export const ConversationProvider = ({
  commands,
  agentStream,
  children,
}: {
  commands: ConversationCommands
  agentStream: AgentStream
  children: ReactNode
}) => (
  <CommandsProvider commands={commands}>
    <AgentStreamProvider commands={agentStream}>{children}</AgentStreamProvider>
  </CommandsProvider>
)

export const AnswerQuestionContext = createContext<
  ((questionId: string, answer: QuestionAnswer) => Promise<number>) | undefined
>(undefined)
