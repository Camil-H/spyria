import type { WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { Name } from '../domain/name.ts'
import { createProject } from '../operations/create-project.ts'
import { useWorkspaceDependencies } from './providers.tsx'

export const NewProjectDialog = ({ workspaceId, onClose }: { workspaceId: WorkspaceId; onClose: () => void }) => {
  const dependencies = useWorkspaceDependencies()
  const [draftName, setDraftName] = useState('')
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    await createProject(dependencies, { workspaceId, name: Name(draftName) })
    onClose()
  }
  return (
    <Dialog label="New project" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          Project name
          <input className={fieldClass} value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <button type="submit" className={buttonClass} disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
