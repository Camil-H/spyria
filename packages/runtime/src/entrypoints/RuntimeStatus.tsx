import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { focusRing, Spinner } from '@spyria/ui'
import { useState } from 'react'
import type { RuntimeStatus as Status } from '../domain/runtime.ts'
import { getRuntimeFailureReason, getRuntimeStatus } from '../queries/get-runtime-status.ts'

const dotClasses: Partial<Record<Status, string>> = {
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
  onRetry: (() => Promise<unknown>) | undefined
}) => {
  const status = useQuery(getRuntimeStatus(workspaceId, chatId))
  const failureReason = useQuery(getRuntimeFailureReason(workspaceId, chatId))
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
  return (
    <span role="status" aria-label="Runtime" className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotClasses[status] ?? 'bg-primary-500'}`} />
      {retriedStatus !== null ? (
        <>
          <Spinner />
          Retrying…
        </>
      ) : status === 'Could not start' && onRetry ? (
        <button type="button" onClick={retry} className={`rounded-md text-ink hover:underline ${focusRing}`}>
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
