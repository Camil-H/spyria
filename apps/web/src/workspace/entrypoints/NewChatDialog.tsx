import { type ProjectId, projectId, type WorkspaceId } from '@hq/kernel'
import { type SubmitEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { useSession } from '../../app/session.tsx'
import type { Chat } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'
import { createChat } from '../operations/create-chat.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { Dialog } from './Dialog.tsx'
import { useWorkspaceDependencies } from './providers.tsx'

export const NewChatDialog = ({
  workspaceId,
  projects,
  onClose,
}: {
  workspaceId: WorkspaceId
  projects: Sidebar['projects']
  onClose: () => void
}) => {
  const dependencies = useWorkspaceDependencies()
  const { memberId } = useSession()
  const navigate = useNavigate()
  const [type, setType] = useState<Chat['type']>('channel')
  const [draftName, setDraftName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const chatId = await createChat(dependencies, {
      workspaceId,
      ownerId: memberId,
      type,
      name: Name(draftName),
      projectId: selectedProjectId,
    })
    onClose()
    navigate(`/w/${workspaceId}/chats/${chatId}`)
  }
  return (
    <Dialog label="New chat" onClose={onClose}>
      <form onSubmit={submit}>
        {(['channel', 'runtime'] as const).map((option) => (
          <label key={option}>
            <input type="radio" name="type" checked={type === option} onChange={() => setType(option)} />
            {option === 'channel' ? 'Channel' : 'Runtime'}
          </label>
        ))}
        <label>
          Chat name
          <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <label>
          Project
          <select
            value={selectedProjectId ?? ''}
            onChange={(event) => setSelectedProjectId(event.target.value ? projectId(event.target.value) : null)}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
