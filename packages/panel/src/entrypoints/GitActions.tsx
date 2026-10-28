import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { buttonClass, fieldClass, ghostButtonClass, labelClass, Spinner, smallGhostButtonClass } from '@spyria/ui'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { type BranchStatus, conflictPromptOf, hasNothingToCommit } from '../domain/workspace.ts'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { getPublishing } from '../queries/get-publishing.ts'
import type { GitActionOutcome } from './commands.ts'
import { usePanelCommands } from './providers.tsx'
import type { ActionOutcome } from './useActionNotice.tsx'

type ConflictOutcome = GitActionOutcome & { conflicts: string[] }

const actionButtonClass = `inline-flex items-center gap-1.5 ${smallGhostButtonClass}`

export const GitActions = ({
  workspaceId,
  chatId,
  actionsSlot,
  baseBranch,
  status,
  onChanged,
  onOutcome,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  actionsSlot: HTMLElement | null
  baseBranch: string
  status: BranchStatus
  onChanged: () => void
  onOutcome: (outcome: ActionOutcome) => void
}) => {
  const { memberId } = useSession()
  const { canPublish, isTurnRunning } = useQuery(getPublishing, workspaceId, chatId, memberId)
  const { isAsleep } = useQuery(getDevWorkspace, workspaceId, chatId)
  const { runGitAction, sendMessage } = usePanelCommands()
  const [message, setMessage] = useState<string>()
  const [runningAction, setRunningAction] = useState<'commit' | 'update'>()
  const [conflictOutcome, setConflictOutcome] = useState<ConflictOutcome>()
  if (!canPublish) return null
  const unavailableReason = isTurnRunning
    ? 'Available when the agent’s turn ends'
    : isAsleep
      ? 'Available when the runtime is awake'
      : undefined
  const isDisabled = runningAction !== undefined || unavailableReason !== undefined
  const isCommitPointless = hasNothingToCommit(status)
  const run = async (action: 'commit' | 'update', text = '') => {
    setRunningAction(action)
    setConflictOutcome(undefined)
    const ran: GitActionOutcome = await runGitAction({ workspaceId, chatId, action, message: text }).catch(() => ({
      isRefused: true,
      text: 'The git action failed',
    }))
    setRunningAction(undefined)
    if (ran.conflicts) setConflictOutcome({ ...ran, conflicts: ran.conflicts })
    else onOutcome(ran)
    if (!ran.isRefused) setMessage(undefined)
    onChanged()
  }
  const askToResolve = async (conflicts: readonly string[]) => {
    setConflictOutcome(undefined)
    await sendMessage({ workspaceId, chatId, text: conflictPromptOf(baseBranch, conflicts) })
      .then(() => onOutcome({ isRefused: false, text: 'Asked the agent to resolve the conflicts' }))
      .catch(() => onOutcome({ isRefused: true, text: 'The request to the agent failed' }))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run('commit', message)
  }
  return (
    <>
      {message === undefined ? (
        actionsSlot &&
        createPortal(
          <>
            <button
              type="button"
              disabled={isDisabled || isCommitPointless}
              title={unavailableReason ?? (isCommitPointless ? 'Nothing to commit' : undefined)}
              onClick={() => setMessage('')}
              className={smallGhostButtonClass}
            >
              Commit
            </button>
            <button
              type="button"
              disabled={isDisabled}
              title={unavailableReason}
              onClick={() => run('update')}
              className={actionButtonClass}
            >
              {runningAction === 'update' && <Spinner />}
              Update from base
            </button>
          </>,
          actionsSlot,
        )
      ) : (
        <form aria-label="Commit changes" onSubmit={submit} className="flex flex-col gap-2">
          <label className={labelClass}>
            Commit message
            <textarea
              className={fieldClass}
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isDisabled || isCommitPointless || !message.trim()}
              className={`inline-flex items-center gap-1.5 ${buttonClass}`}
            >
              {runningAction === 'commit' && <Spinner />}
              Commit
            </button>
            <button type="button" onClick={() => setMessage(undefined)} className={ghostButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {conflictOutcome && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-muted">
            {conflictOutcome.text}
          </p>
          <button type="button" onClick={() => askToResolve(conflictOutcome.conflicts)} className={buttonClass}>
            Ask the agent to resolve conflicts
          </button>
        </div>
      )}
    </>
  )
}
