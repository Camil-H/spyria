import { createContext, type ReactNode, use } from 'react'
import type { AgentStream, ConversationCommands } from './commands.ts'
import type { QuestionAnswer } from './endpoints.ts'

const ConversationCommandsContext = createContext<ConversationCommands | null>(null)
const AgentStreamContext = createContext<AgentStream | null>(null)

export const ConversationProvider = ({
  commands,
  agentStream,
  children,
}: {
  commands: ConversationCommands
  agentStream: AgentStream
  children: ReactNode
}) => (
  <ConversationCommandsContext value={commands}>
    <AgentStreamContext value={agentStream}>{children}</AgentStreamContext>
  </ConversationCommandsContext>
)

export const useAgentStream = () => {
  const agentStream = use(AgentStreamContext)
  if (!agentStream) throw new Error('ConversationProvider is missing')
  return agentStream
}

export const useConversationCommands = () => {
  const commands = use(ConversationCommandsContext)
  if (!commands) throw new Error('ConversationProvider is missing')
  return commands
}

export const AnswerQuestionContext = createContext<
  ((questionId: string, answer: QuestionAnswer) => Promise<number>) | undefined
>(undefined)
