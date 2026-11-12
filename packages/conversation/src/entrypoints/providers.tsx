import type { MemberId, MessageId } from '@spyria/kernel'
import { createCommandsContext } from '@spyria/ui'
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

export const QuestionAnswererContext = createContext<{
  answer: (questionId: string, answer: QuestionAnswer) => Promise<number>
  mayAnswerAsPrompter: boolean
  viewerId: MemberId | null
  githubTools: readonly string[]
}>({ answer: async () => 0, mayAnswerAsPrompter: false, viewerId: null, githubTools: [] })

export const ToolsAwaitingApprovalContext = createContext<ReadonlySet<string>>(new Set())

export const MentionNamesContext = createContext<readonly string[]>([])

export const ChatNameContext = createContext('')

export const ChatMediaContext = createContext<{ chatId: string; isRuntime: boolean } | null>(null)

export const LoadedRemoteImagesContext = createContext<{
  sources: ReadonlySet<string>
  load: (source: string) => void
} | null>(null)

export const LinkedMessageContext = createContext<string | null>(null)

export type ComposerQuote = Readonly<{ id: MessageId; authorName: string; body: string }>

export const QuoteContext = createContext<{
  quoteIn: (threadRootId: MessageId | null) => ComposerQuote | null
  setQuote: (threadRootId: MessageId | null, quote: ComposerQuote | null) => void
} | null>(null)
