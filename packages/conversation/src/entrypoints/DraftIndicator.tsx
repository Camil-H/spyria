import { useQuery } from '@hq/db/react'
import { type ChatId, workspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { Pencil } from 'lucide-react'
import { useParams } from 'react-router'
import { hasDraft } from '../queries/has-draft.ts'

export const DraftIndicator = ({ chatId }: { chatId: ChatId }) => {
  const { memberId } = useSession()
  const isDraftPresent = useQuery(hasDraft(workspaceId(useParams().workspaceId ?? ''), chatId, memberId))
  return isDraftPresent ? (
    <Pencil role="img" aria-label="Has unsent draft" size={12} className="shrink-0 text-muted" />
  ) : null
}
