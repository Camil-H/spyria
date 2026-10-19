import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, fieldClass, labelClass, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { DisplayName } from '../domain/display-name.ts'
import { useProfileCommands } from './providers.tsx'

export const DisplayNameForm = ({ workspaceId, currentName }: { workspaceId: WorkspaceId; currentName: string }) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const [draftName, setDraftName] = useState(currentName)
  const [isSaved, setIsSaved] = useState(false)
  const trimmedName = draftName.trim()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsSaved(await run(() => commands.renameMember({ workspaceId, name: DisplayName(draftName) })))
  }
  return (
    <section aria-label="Display name">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Display name
          <input
            className={`${fieldClass} w-64`}
            value={draftName}
            onChange={(event) => {
              setDraftName(event.target.value)
              setIsSaved(false)
            }}
          />
        </label>
        <button type="submit" className={buttonClass} disabled={trimmedName === '' || trimmedName === currentName}>
          Save
        </button>
        {isSaved && <p className="text-sm text-muted">Saved</p>}
        <ErrorMessage message={errorMessage} />
      </form>
    </section>
  )
}
