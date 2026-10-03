import { useQuery } from '@hq/db'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { Bot, GitBranch, Hash } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { Link, Navigate, useOutletContext, useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { markChatRead } from '../operations/mark-chat-read.ts'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'
import { useConversationDependencies } from './providers.tsx'

const bubbleClassName = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'

export const ChatView = ({ headerActions }: { headerActions?: ReactNode }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const chatId = toChatId(useParams().chatId ?? '')
  const conversation = useQuery(getConversation(workspaceId, chatId, memberId))
  const dependencies = useConversationDependencies()
  const newestMessageId = conversation?.messages.at(-1)?.id
  useEffect(() => {
    if (newestMessageId) markChatRead(dependencies, { workspaceId, chatId, memberId })
  }, [dependencies, workspaceId, chatId, memberId, newestMessageId])
  if (!conversation) return <Navigate to={`/w/${workspaceId}`} replace />
  const ChatTypeIcon = conversation.type === 'runtime' ? Bot : Hash
  const chatTypeLabel = conversation.type === 'runtime' ? 'Runtime chat' : 'Channel'
  return (
    <div key={chatId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-6">
      <header>
        <div className="flex items-center gap-x-3">
          <div className="flex min-w-0 items-center gap-2">
            <ChatTypeIcon aria-label={chatTypeLabel} role="img" size={20} className="shrink-0 text-muted" />
            <h1 className="truncate text-2xl font-semibold">{conversation.title}</h1>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-x-2">
            {conversation.type === 'runtime' && (
              <>
                <span className="text-sm text-muted">
                  Agent acts as <strong className="font-semibold text-ink">{conversation.ownerName}</strong>
                </span>
                <span className={bubbleClassName}>
                  {conversation.model} · {conversation.reasoningEffort}
                </span>
                {conversation.gitBranch !== null && (
                  <span className={`${bubbleClassName} inline-flex items-center gap-1`}>
                    <GitBranch aria-label="Git branch" role="img" size={12} />
                    {conversation.gitBranch}
                  </span>
                )}
              </>
            )}
            {headerActions}
          </div>
        </div>
        {conversation.origin && (
          <Link
            to={`/w/${workspaceId}/chats/${conversation.origin.chatId}`}
            className="mt-1 inline-block text-sm text-muted underline"
          >
            Started from {conversation.origin.name}
          </Link>
        )}
      </header>
      <MessageList conversation={conversation} />
      <Composer workspaceId={workspaceId} chatId={chatId} isRuntime={conversation.type === 'runtime'} />
    </div>
  )
}
