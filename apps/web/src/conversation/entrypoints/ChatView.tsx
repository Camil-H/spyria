import { useQuery } from '@hq/db'
import { chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { Link, Navigate, useOutletContext, useParams } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'

export const ChatView = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const chatId = toChatId(useParams().chatId ?? '')
  const conversation = useQuery(getConversation(workspaceId, chatId, memberId))
  if (!conversation) return <Navigate to={`/w/${workspaceId}`} replace />
  return (
    <div key={chatId} className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">{conversation.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{conversation.type === 'runtime' ? 'Runtime view' : 'Channel view'}</span>
          {conversation.type === 'runtime' && (
            <>
              <span>Agent acts as {conversation.ownerName}</span>
              <span className="rounded-full border border-line px-2 py-0.5 text-xs">{conversation.model}</span>
            </>
          )}
          {conversation.origin && (
            <Link to={`/w/${workspaceId}/chats/${conversation.origin.chatId}`} className="underline">
              Started from {conversation.origin.name}
            </Link>
          )}
        </div>
      </header>
      <MessageList conversation={conversation} />
      <Composer workspaceId={workspaceId} chatId={chatId} />
    </div>
  )
}
