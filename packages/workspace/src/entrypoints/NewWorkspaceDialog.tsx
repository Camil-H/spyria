import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, Dialog, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { Name } from '../domain/name.ts'
import { useWorkspaceCommands } from './providers.tsx'

export const NewWorkspaceDialog = ({ workspaceId, onClose }: { workspaceId: WorkspaceId; onClose: () => void }) => {
  const commands = useWorkspaceCommands()
  const { memberId } = useSession()
  const navigate = useNavigate()
  const [draftName, setDraftName] = useState('')
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const newWorkspaceId = await commands.createWorkspace({ workspaceId, ownerId: memberId, name: Name(draftName) })
    onClose()
    navigate(`/w/${newWorkspaceId}`)
  }
  return (
    <Dialog label="New workspace" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          Workspace name
          <input
            className={fieldClass}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            ref={(input) => void setTimeout(() => input?.focus())}
          />
        </label>
        <button type="submit" className={buttonClass} disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
