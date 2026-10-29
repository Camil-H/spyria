import { useQuery } from '@spyria/db/react'
import { useSession } from '@spyria/session'
import { iconButtonClass } from '@spyria/ui'
import { ChevronsDownUp, ChevronsUpDown, FileDiff, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { branchStatusOf, changeGroupsOf, commitsOf } from '../domain/workspace.ts'
import { getPublishing } from '../queries/get-publishing.ts'
import { BranchStatusLine } from './BranchStatusLine.tsx'
import { EmptyState } from './EmptyState.tsx'
import { FileDiffList } from './FileDiffList.tsx'
import { GitActions } from './GitActions.tsx'
import { PublishActions } from './PublishActions.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass, moreCommitsNotice } from './ui.ts'
import { useActionNotice } from './useActionNotice.tsx'
import { useFileExpansion } from './useFileExpansion.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const ChangesTab = ({ workspaceId, chatId, actionsSlot }: TabProps) => {
  const { memberId } = useSession()
  const { workingBranch, baseBranch } = useQuery(getPublishing, workspaceId, chatId, memberId)
  const changesReading = useWorkspaceReading(workspaceId, chatId, 'changes')
  const commitsReading = useWorkspaceReading(workspaceId, chatId, 'commits')
  const statusReading = useWorkspaceReading(workspaceId, chatId, 'status')
  const { toast, notify } = useActionNotice()
  const [isRefreshAsked, setIsRefreshAsked] = useState(false)
  const commits = commitsReading.reading
  const isRead = changesReading.reading !== undefined && commits !== undefined
  const changeGroups = changeGroupsOf(changesReading.reading, commits)
  const { isExpanded, toggle, isAnyExpanded, setAllCollapsed } = useFileExpansion(changeGroups)
  const ExpansionIcon = isAnyExpanded ? ChevronsDownUp : ChevronsUpDown
  const expansionLabel = isAnyExpanded ? 'Collapse all' : 'Open all'
  const status = branchStatusOf(statusReading.reading)
  const isRefreshing = changesReading.isLoading || commitsReading.isLoading || statusReading.isLoading
  if (isRefreshAsked && !isRefreshing) {
    setIsRefreshAsked(false)
    notify({ isRefused: false, text: 'Changes refreshed' })
  }
  const refresh = () => {
    changesReading.refresh()
    commitsReading.refresh()
    statusReading.refresh()
  }
  const refreshAsked = () => {
    setIsRefreshAsked(true)
    refresh()
  }
  return (
    <div className="flex flex-col gap-4">
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {workingBranch && baseBranch && (
        <BranchStatusLine workingBranch={workingBranch} baseBranch={baseBranch} status={status} />
      )}
      <PublishActions
        workspaceId={workspaceId}
        chatId={chatId}
        actionsSlot={actionsSlot}
        status={status}
        commitSubjects={commitsOf(commits?.log).map(({ subject }) => subject)}
        onPublished={statusReading.refresh}
        onOutcome={notify}
      />
      {baseBranch && (
        <GitActions
          workspaceId={workspaceId}
          chatId={chatId}
          actionsSlot={actionsSlot}
          baseBranch={baseBranch}
          status={status}
          onChanged={refresh}
          onOutcome={notify}
        />
      )}
      {actionsSlot &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh"
              aria-busy={isRefreshing}
              onClick={refreshAsked}
              className={`-order-1 ${iconButtonClass}`}
            >
              <RefreshCw aria-hidden className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            {changeGroups.some(({ changes }) => changes.length > 0) && (
              <button
                type="button"
                aria-label={expansionLabel}
                title={expansionLabel}
                onClick={() => setAllCollapsed(isAnyExpanded)}
                className={`-order-1 ${iconButtonClass}`}
              >
                <ExpansionIcon aria-hidden className="size-4" />
              </button>
            )}
          </>,
          actionsSlot,
        )}
      {isRead && changeGroups.length === 0 && (
        <EmptyState Icon={FileDiff} title="No changes" hint="Edits on the working branch against its base show here." />
      )}
      {changeGroups.map(({ sha, title, commit, changes, isCut }) => (
        <section
          key={sha ?? title}
          aria-label={sha ? `Commit ${sha}` : title || undefined}
          className="flex flex-col gap-2"
        >
          {(sha || title) && (
            <h3 className="text-xs font-semibold text-muted">
              {sha && <span className="font-mono font-normal">{sha} </span>}
              {title}
            </h3>
          )}
          {commit && (
            <div className="-mt-1.5 flex flex-col gap-1 text-xs text-muted">
              <span>
                {commit.author} · {commit.committedAt.slice(11, 16)} UTC
              </span>
              {commit.body && <p className="whitespace-pre-wrap break-words text-ink">{commit.body}</p>}
            </div>
          )}
          <FileDiffList
            changes={changes}
            groupName={sha ? `commit ${sha}` : title.toLowerCase()}
            isExpanded={(path) => isExpanded(sha ?? title, path)}
            onToggle={(path) => toggle(sha ?? title, path)}
          />
          {isCut && <p className={emptyClass}>Diff truncated</p>}
        </section>
      ))}
      {commits?.hasMoreCommits === true && <p className={emptyClass}>{moreCommitsNotice}</p>}
      {toast}
    </div>
  )
}

export default ChangesTab
