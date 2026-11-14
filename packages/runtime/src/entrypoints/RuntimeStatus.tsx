import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { inlineActionClass, Spinner } from '@spyria/ui'
import { type ReactNode, useState } from 'react'
import type { RuntimeStatus as Status } from '../domain/runtime.ts'
import { getRuntimeFailureReason, getRuntimeStatus } from '../queries/get-runtime-status.ts'

const dotClasses: Partial<Record<Status, string>> = {
  'Not started': 'bg-muted',
  'Starting…': 'bg-accent',
  Ready: 'bg-success',
  Sleeping: 'bg-muted',
  'Host offline': 'bg-danger',
  'Could not start': 'bg-danger',
}

export const RuntimeStatus = ({
  workspaceId,
  chatId,
  onRetry,
  menu,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  onRetry: (() => Promise<unknown>) | undefined
  menu: ((status: ReactNode) => ReactNode) | undefined
}) => {
  const status = useQuery(getRuntimeStatus, workspaceId, chatId)
  const failureReason = useQuery(getRuntimeFailureReason, workspaceId, chatId)
  const [retriedStatus, setRetriedStatus] = useState<Status | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (retriedStatus !== null && retriedStatus !== status) setRetriedStatus(null)
  const retry = () => {
    setRetriedStatus(status)
    setRetryError(null)
    onRetry?.().catch((error: unknown) => {
      setRetriedStatus(null)
      setRetryError(error instanceof Error ? error.message : 'Could not retry')
    })
  }
  const statusClass = 'inline-flex items-center gap-1.5 text-xs text-muted'
  const dot = <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotClasses[status] ?? 'bg-accent'}`} />
  if (status === 'Ready' && menu)
    return (
      <span role="status" aria-label="Runtime" className={statusClass}>
        {menu(
          <>
            {dot}
            {status}
          </>,
        )}
      </span>
    )
  return (
    <span role="status" aria-label="Runtime" className={statusClass}>
      {dot}
      {retriedStatus !== null ? (
        <>
          <Spinner />
          Retrying…
        </>
      ) : status === 'Could not start' && onRetry ? (
        <button type="button" onClick={retry} className={inlineActionClass}>
          Could not start · Retry
        </button>
      ) : (
        status
      )}
      {status === 'Could not start' && failureReason && (
        <span className="whitespace-pre-line text-ink">{failureReason}</span>
      )}
      {retryError && <span className="text-ink">{retryError}</span>}
    </span>
  )
}
