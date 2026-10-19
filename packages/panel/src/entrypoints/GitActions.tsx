import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { buttonClass, fieldClass, ghostButtonClass, labelClass, Spinner } from '@spyria/ui'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { conflictPromptOf } from '../domain/workspace.ts'
import { getDevWorkspace } from '../queries/get-dev-workspace.ts'
import { getPublishing } from '../queries/get-publishing.ts'
import type { GitActionOutcome } from './commands.ts'
import { usePanelCommands } from './providers.tsx'

export const GitActions = ({
  workspaceId,
  chatId,
  actionsSlot,
  baseBranch,
  onChanged,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  actionsSlot: HTMLElement | null
  baseBranch: string
  onChanged: () => void
}) => {
  const { memberId } = useSession()
  const { canPublish, isTurnRunning } = useQuery(getPublishing(workspaceId, chatId, memberId))
  const { isAsleep } = useQuery(getDevWorkspace(workspaceId, chatId))
  const { runGitAction, sendMessage } = usePanelCommands()
  const [message, setMessage] = useState<string>()
  const [isRunning, setIsRunning] = useState(false)
  const [outcome, setOutcome] = useState<GitActionOutcome>()
  if (!canPublish) return null
  const unavailableReason = isTurnRunning
    ? 'Available when the agent’s turn ends'
    : isAsleep
      ? 'Available when the runtime is awake'
      : undefined
  const isDisabled = isRunning || unavailableReason !== undefined
  const run = async (action: 'commit' | 'update', text = '') => {
    setIsRunning(true)
    setOutcome(undefined)
    const ran = await runGitAction({ workspaceId, chatId, action, message: text }).catch(() => ({
      isRefused: true,
      text: 'The git action failed',
    }))
    setOutcome(ran)
    setIsRunning(false)
    if (!ran.isRefused) setMessage(undefined)
    onChanged()
  }
  const askToResolve = async (conflicts: readonly string[]) => {
    setOutcome(undefined)
    await sendMessage({ workspaceId, chatId, text: conflictPromptOf(baseBranch, conflicts) })
      .then(() => setOutcome({ isRefused: false, text: 'Asked the agent to resolve the conflicts' }))
      .catch(() => setOutcome({ isRefused: true, text: 'The request to the agent failed' }))
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
              disabled={isDisabled}
              title={unavailableReason}
              onClick={() => setMessage('')}
              className={ghostButtonClass}
            >
              Commit
            </button>
            <button
              type="button"
              disabled={isDisabled}
              title={unavailableReason}
              onClick={() => run('update')}
              className={ghostButtonClass}
            >
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
            <button type="submit" disabled={isDisabled || !message.trim()} className={buttonClass}>
              Commit
            </button>
            <button type="button" onClick={() => setMessage(undefined)} className={ghostButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {isRunning && <Spinner />}
      {outcome && (
        <div className="flex flex-col items-start gap-2">
          <p role={outcome.isRefused ? 'alert' : 'status'} className="text-sm text-muted">
            {outcome.text}
          </p>
          {outcome.conflicts && (
            <button type="button" onClick={() => askToResolve(outcome.conflicts ?? [])} className={buttonClass}>
              Ask the agent to resolve conflicts
            </button>
          )}
        </div>
      )}
    </>
  )
}
