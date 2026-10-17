import { type ChatVisibility, type ProjectId, projectId, type WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Chat } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'

const Choice = <Option extends string>({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string
  name: string
  options: Record<Option, string>
  value: Option
  onChange: (option: Option) => void
}) => (
  <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg border border-line bg-app p-1">
    {(Object.keys(options) as Option[]).map((option) => (
      <label
        key={option}
        className="relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-sm text-muted hover:bg-hover hover:text-ink has-checked:bg-selected has-checked:font-medium has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus"
      >
        <input
          type="radio"
          className="absolute inset-0 cursor-pointer opacity-0"
          name={name}
          checked={value === option}
          onChange={() => onChange(option)}
        />
        {options[option]}
      </label>
    ))}
  </div>
)

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
        <Choice
          label="Chat type"
          name="type"
          options={{ channel: 'Channel', runtime: 'Runtime' }}
          value={type}
          onChange={setType}
        />
        {type === 'channel' && (
          <Choice
            label="Visibility"
            name="visibility"
            options={{ public: 'Public', private: 'Private' }}
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
