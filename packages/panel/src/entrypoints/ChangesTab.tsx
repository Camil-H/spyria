import { DiffView, focusRing, iconButtonClass } from '@hq/ui'
import { FileDiff, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { commitsOf, fileChangesOf } from '../domain/workspace.ts'
import { EmptyState } from './EmptyState.tsx'
import { PublishActions } from './PublishActions.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const ChangesTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const { reading, refresh } = useWorkspaceReading(workspaceId, chatId, 'changes')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const changes = fileChangesOf(reading?.patch)
  const selectedChange = changes.find((change) => change.path === selectedPath)
  return (
    <div className="flex flex-col gap-4">
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      <PublishActions
        workspaceId={workspaceId}
        chatId={chatId}
        actionsSlot={actionsSlot}
        commitSubjects={commitsOf(reading?.log).map(({ subject }) => subject)}
      />
      {actionsSlot &&
        createPortal(
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
            className={`-order-1 ${iconButtonClass}`}
          >
            <RefreshCw aria-hidden className="size-4" />
          </button>,
          actionsSlot,
        )}
      {reading && changes.length === 0 && (
        <EmptyState Icon={FileDiff} title="No changes" hint="Edits on the working branch against its base show here." />
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {changes.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              aria-pressed={change.path === selectedPath}
              onClick={() => setSelectedPath(change.path)}
              className={`flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md px-2 py-1 text-left hover:bg-hover aria-pressed:bg-selected ${focusRing}`}
            >
              <span className="break-all">{change.path}</span>
              <span className="font-mono text-xs text-muted">
                {change.status} +{change.additions} −{change.deletions}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {reading?.truncated === true && <p className={emptyClass}>Diff truncated</p>}
      {selectedChange && <DiffView lines={selectedChange.lines} />}
    </div>
  )
}

export default ChangesTab
