import type { WorkspaceId } from '@hq/kernel'
import { type SubmitEvent, useState } from 'react'
import { Name } from '../domain/name.ts'
import { createProject } from '../operations/create-project.ts'
import { Dialog } from './Dialog.tsx'
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
      <form onSubmit={submit}>
        <label>
          Project name
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <button type="submit" disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
