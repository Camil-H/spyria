import { useQuery } from '@spyria/db/react'
import { focusRing, Spinner } from '@spyria/ui'
import { useState } from 'react'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'

type StatusProps = Pick<TabProps, 'workspaceId' | 'chatId'>

const AsleepStatus = ({ workspaceId, chatId, canWake }: StatusProps & { canWake: boolean }) => {
  const { wakeWorkspace } = usePanelCommands()
  const [wakeState, setWakeState] = useState<'idle' | 'waking' | 'failed'>('idle')
  const wake = () => {
    setWakeState('waking')
    wakeWorkspace({ workspaceId, chatId }).then(
      () => setWakeState('idle'),
      () => setWakeState('failed'),
    )
  }
  return (
    <p
      role="status"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-hover px-2 py-1 text-xs text-muted"
    >
      {canWake ? 'Runtime asleep' : 'Runtime going to sleep'} · showing the last snapshot
      {wakeState === 'waking' ? (
        <Spinner />
      ) : (
        canWake && (
          <button type="button" onClick={wake} className={`font-medium text-ink hover:underline ${focusRing}`}>
            Wake
          </button>
        )
      )}
      {wakeState === 'failed' && <span className="text-ink">Could not wake the runtime</span>}
    </p>
  )
}

export const WorkspaceStatus = ({ workspaceId, chatId }: StatusProps) => {
  const { isAsleep, canWake } = useQuery(getDevWorkspace, workspaceId, chatId)
  return isAsleep ? <AsleepStatus workspaceId={workspaceId} chatId={chatId} canWake={canWake} /> : null
}
