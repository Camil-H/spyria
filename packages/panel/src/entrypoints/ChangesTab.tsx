import { useQuery } from '@spyria/db/react'
import { useSession } from '@spyria/session'
import { iconButtonClass } from '@spyria/ui'
import { FileDiff, RefreshCw } from 'lucide-react'
import { createPortal } from 'react-dom'
import { branchStatusOf, commitsOf, fileChangesOf } from '../domain/workspace.ts'
import { getPublishing } from '../queries/get-publishing.ts'
import { BranchStatusLine } from './BranchStatusLine.tsx'
import { EmptyState } from './EmptyState.tsx'
import { FileDiffList } from './FileDiffList.tsx'
import { GitActions } from './GitActions.tsx'
import { PublishActions } from './PublishActions.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const ChangesTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const { memberId } = useSession()
  const { workingBranch, baseBranch } = useQuery(getPublishing(workspaceId, chatId, memberId))
  const { reading, refresh: refreshChanges } = useWorkspaceReading(workspaceId, chatId, 'changes')
  const { reading: statusReading, refresh: refreshStatus } = useWorkspaceReading(workspaceId, chatId, 'status')
  const changes = fileChangesOf(reading?.patch)
  const refresh = () => {
    refreshChanges()
    refreshStatus()
  }
  return (
    <div className="flex flex-col gap-4">
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {workingBranch && baseBranch && (
        <BranchStatusLine
          workingBranch={workingBranch}
          baseBranch={baseBranch}
          status={branchStatusOf(statusReading)}
        />
      )}
      <PublishActions
        workspaceId={workspaceId}
        chatId={chatId}
        actionsSlot={actionsSlot}
        commitSubjects={commitsOf(reading?.log).map(({ subject }) => subject)}
        onPublished={refreshStatus}
      />
      {baseBranch && (
        <GitActions
          workspaceId={workspaceId}
          chatId={chatId}
          actionsSlot={actionsSlot}
          baseBranch={baseBranch}
          onChanged={refresh}
        />
      )}
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
      <FileDiffList changes={changes} />
      {reading?.truncated === true && <p className={emptyClass}>Diff truncated</p>}
    </div>
  )
}

export default ChangesTab
