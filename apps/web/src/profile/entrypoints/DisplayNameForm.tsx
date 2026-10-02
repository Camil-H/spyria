import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { DisplayName } from '../domain/display-name.ts'
import { renameMember } from '../operations/rename-member.ts'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileDependencies } from './providers.tsx'
import { useGuardedAction } from './useGuardedAction.ts'

export const DisplayNameForm = ({
  workspaceId,
  memberId,
  currentName,
}: {
  workspaceId: WorkspaceId
  memberId: MemberId
  currentName: string
}) => {
  const dependencies = useProfileDependencies()
  const { errorMessage, run } = useGuardedAction()
  const [draftName, setDraftName] = useState(currentName)
  const [isSaved, setIsSaved] = useState(false)
  const trimmedName = draftName.trim()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsSaved(await run(() => renameMember(dependencies, { workspaceId, memberId, name: DisplayName(draftName) })))
  }
  return (
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
  )
}
