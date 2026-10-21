import { useQuery } from '@spyria/db/react'
import { focusRing, Spinner } from '@spyria/ui'
import { useState } from 'react'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'

export const WorkspaceStatus = ({ workspaceId, chatId }: Pick<TabProps, 'workspaceId' | 'chatId'>) => {
  const { isAsleep } = useQuery(getDevWorkspace, workspaceId, chatId)
  const { wakeWorkspace } = usePanelCommands()
  const [wakeState, setWakeState] = useState<'idle' | 'waking' | 'failed'>('idle')
  if (!isAsleep) return null
  const wake = () => {
    setWakeState('waking')
    wakeWorkspace({ workspaceId, chatId }).catch(() => setWakeState('failed'))
  }
  return (
    <p
      role="status"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-hover px-2 py-1 text-xs text-muted"
    >
      Runtime asleep · showing the last snapshot
      {wakeState === 'waking' ? (
        <Spinner />
      ) : (
        <button type="button" onClick={wake} className={`font-medium text-ink hover:underline ${focusRing}`}>
          Wake
        </button>
      )}
      {wakeState === 'failed' && <span className="text-ink">Could not wake the runtime</span>}
    </p>
  )
}
