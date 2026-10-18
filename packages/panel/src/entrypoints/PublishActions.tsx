import { useQuery } from '@hq/db/react'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, fieldClass, ghostButtonClass, labelClass, Spinner } from '@hq/ui'
import { type FormEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { getPublishing } from '../queries/get-publishing.ts'
import { usePanelCommands } from './providers.tsx'

type Outcome = { isRefused: boolean; text: string }

export const PublishActions = ({
  workspaceId,
  chatId,
  actionsSlot,
  commitSubjects,
  onPublished,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  actionsSlot: HTMLElement | null
  commitSubjects: readonly string[]
  onPublished: () => void
}) => {
  const { memberId } = useSession()
  const { canPublish, chatName, hasOpenPullRequest } = useQuery(getPublishing(workspaceId, chatId, memberId))
  const { publishBranch } = usePanelCommands()
  const [draft, setDraft] = useState<{ title: string; body: string }>()
  const [isPublishing, setIsPublishing] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>()
  if (!canPublish) return null
  const publish = async (action: 'push' | 'pull_request') => {
    setIsPublishing(true)
    setOutcome(undefined)
    const published = await publishBranch({
      workspaceId,
      chatId,
      action,
      draft: draft ?? { title: '', body: '' },
    }).catch(() => ({ isRefused: true, text: 'Publishing failed' }))
    setOutcome(published)
    setIsPublishing(false)
    if (!published.isRefused) setDraft(undefined)
    onPublished()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void publish('pull_request')
  }
  return (
    <>
      {draft ? (
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
            <button type="submit" disabled={isPublishing || !draft.title.trim()} className={buttonClass}>
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
            <button type="button" disabled={isPublishing} onClick={() => publish('push')} className={ghostButtonClass}>
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
      )}
      {isPublishing && <Spinner />}
      {outcome && (
        <p role={outcome.isRefused ? 'alert' : 'status'} className="text-sm text-muted">
          {outcome.text}
        </p>
      )}
    </>
  )
}
