import { useQuery } from '@hq/db/react'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { focusRing } from '@hq/ui'
import { getRuntimeStatus } from '../queries/get-runtime-status.ts'

const chipClass = 'rounded-full border border-line px-2 py-0.5 text-xs'

export const RuntimeStatus = ({
  workspaceId,
  chatId,
  onRetry,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  onRetry: () => void
}) => {
  const status = useQuery(getRuntimeStatus(workspaceId, chatId))
  return (
    <span role="status" aria-label="Runtime" className="inline-flex">
      {status === 'Could not start' ? (
        <button type="button" onClick={onRetry} className={`${chipClass} text-ink hover:bg-hover ${focusRing}`}>
          Could not start · Retry
        </button>
      ) : (
        <span className={`${chipClass} text-muted`}>{status}</span>
      )}
    </span>
  )
}
