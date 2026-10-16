import { useQuery } from '@hq/db/react'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { focusRing } from '@hq/ui'
import type { RuntimeStatus as Status } from '../domain/runtime.ts'
import { getRuntimeStatus } from '../queries/get-runtime-status.ts'

const dotClasses: Record<Status, string> = {
  'Not started': 'bg-grey-500',
  'Starting…': 'bg-primary-500',
  Ready: 'bg-green-500',
  Sleeping: 'bg-grey-500',
  'Host offline': 'bg-red-500',
  'Could not start': 'bg-red-500',
}

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
    <span role="status" aria-label="Runtime" className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotClasses[status]}`} />
      {status === 'Could not start' ? (
        <button type="button" onClick={onRetry} className={`rounded-md text-ink hover:underline ${focusRing}`}>
          Could not start · Retry
        </button>
      ) : (
        status
      )}
    </span>
  )
}
