import { useQuery } from '@hq/db'
import { chatId, type WorkspaceId } from '@hq/kernel'
import { Navigate, useOutletContext, useParams } from 'react-router'
import { getChatSummary } from '../queries/get-chat-summary.ts'

export const ChatStub = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chat = useQuery(getChatSummary(workspaceId, chatId(useParams().chatId ?? '')))
  if (!chat) return <Navigate to={`/w/${workspaceId}`} replace />
  return (
    <>
      <h1>{chat.name}</h1>
      <p>{chat.type === 'runtime' ? 'Runtime view' : 'Channel view'}</p>
    </>
  )
}
