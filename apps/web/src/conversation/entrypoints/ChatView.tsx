import { useQuery } from '@hq/db'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { Bot, GitBranch, Hash } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, Navigate, useOutletContext, useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'

const bubbleClassName = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'

export const ChatView = ({ headerActions, aside }: { headerActions?: ReactNode; aside?: ReactNode }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const chatId = toChatId(useParams().chatId ?? '')
  const conversation = useQuery(getConversation(workspaceId, chatId, memberId))
  if (!conversation) return <Navigate to={`/w/${workspaceId}`} replace />
  const ChatTypeIcon = conversation.type === 'runtime' ? Bot : Hash
  const chatTypeLabel = conversation.type === 'runtime' ? 'Runtime chat' : 'Channel'
  return (
    <div key={chatId} className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <ChatTypeIcon aria-label={chatTypeLabel} role="img" size={20} className="shrink-0 text-muted" />
            <h1 className="text-2xl font-semibold">{conversation.title}</h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
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
      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <MessageList conversation={conversation} />
          <Composer workspaceId={workspaceId} chatId={chatId} />
        </div>
        {aside}
      </div>
    </div>
  )
}
