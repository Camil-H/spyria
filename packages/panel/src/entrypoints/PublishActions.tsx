import { useQuery } from '@spyria/db/react'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { buttonClass, fieldClass, ghostButtonClass, labelClass, Spinner } from '@spyria/ui'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { type BranchStatus, hasNothingToPush } from '../domain/workspace.ts'
import { getPublishing } from '../queries/get-publishing.ts'
import { usePanelCommands } from './providers.tsx'
import type { ActionOutcome } from './useActionNotice.tsx'

export const PublishActions = ({
  workspaceId,
  chatId,
  actionsSlot,
  status,
  commitSubjects,
  onPublished,
  onOutcome,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  actionsSlot: HTMLElement | null
  status: BranchStatus
  commitSubjects: readonly string[]
  onPublished: () => void
  onOutcome: (outcome: ActionOutcome) => void
}) => {
  const { memberId } = useSession()
  const { canPublish, chatName, hasOpenPullRequest } = useQuery(getPublishing, workspaceId, chatId, memberId)
  const { publishBranch } = usePanelCommands()
  const [draft, setDraft] = useState<{ title: string; body: string }>()
  const [publishingAction, setPublishingAction] = useState<'push' | 'pull_request'>()
  if (!canPublish) return null
  const isPublishing = publishingAction !== undefined
  const isPushPointless = hasNothingToPush(status)
  const publish = async (action: 'push' | 'pull_request') => {
    setPublishingAction(action)
    const published = await publishBranch({
      workspaceId,
      chatId,
      action,
      draft: draft ?? { title: '', body: '' },
    }).catch(() => ({ isRefused: true, text: 'Publishing failed' }))
    onOutcome(published)
    setPublishingAction(undefined)
    if (!published.isRefused) setDraft(undefined)
    onPublished()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void publish('pull_request')
  }
  return draft ? (
    <form aria-label="Open pull request" onSubmit={submit} className="flex flex-col gap-2">
      <label className={labelClass}>
        Title
        <input
          className={fieldClass}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label className={labelClass}>
        Description
        <textarea
          className={fieldClass}
          rows={4}
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPublishing || !draft.title.trim()}
          className={`inline-flex items-center gap-1.5 ${buttonClass}`}
        >
          {publishingAction === 'pull_request' && <Spinner />}
          Create pull request
        </button>
        <button type="button" onClick={() => setDraft(undefined)} className={ghostButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  ) : (
    actionsSlot &&
      createPortal(
        <>
          <button
            type="button"
            disabled={isPublishing || isPushPointless}
            title={isPushPointless ? 'Nothing to push' : undefined}
            onClick={() => publish('push')}
            className={`inline-flex items-center gap-1.5 ${ghostButtonClass}`}
          >
            {publishingAction === 'push' && <Spinner />}
            Push
          </button>
          {!hasOpenPullRequest && (
            <button
              type="button"
              disabled={isPublishing}
              onClick={() =>
                setDraft({ title: chatName, body: commitSubjects.map((subject) => `- ${subject}`).join('\n') })
              }
              className={buttonClass}
            >
              Open pull request
            </button>
          )}
        </>,
        actionsSlot,
      )
  )
}
