import { type ChatVisibility, type ProjectId, projectId, type WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, fieldClass, labelClass, SegmentedChoice } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Chat } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'

export const NewChatDialog = ({
  workspaceId,
  projects,
  onClose,
}: {
  workspaceId: WorkspaceId
  projects: Sidebar['projects']
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const navigate = useNavigate()
  const [type, setType] = useState<Chat['type']>('channel')
  const [visibility, setVisibility] = useState<ChatVisibility>('public')
  const [draftName, setDraftName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const chatId = await commands.createChat({
      workspaceId,
      type,
      ...(type === 'channel' && { visibility }),
      name: Name(draftName),
      projectId: selectedProjectId,
    })
    onClose()
    navigate(`/w/${workspaceId}/chats/${chatId}`)
  }
  return (
    <Dialog label="New chat" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <SegmentedChoice
          label="Chat type"
          name="type"
          options={['channel', 'runtime']}
          labels={{ channel: 'Channel', runtime: 'Runtime' }}
          value={type}
          onChange={setType}
        />
        {type === 'channel' && (
          <SegmentedChoice
            label="Visibility"
            name="visibility"
            options={['public', 'private']}
            labels={{ public: 'Public', private: 'Private' }}
            value={visibility}
            onChange={setVisibility}
          />
        )}
        <label className={labelClass}>
          Chat name
          <input className={fieldClass} value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <label className={labelClass}>
          Project
          <select
            className={fieldClass}
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
        <button type="submit" className={buttonClass} disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
