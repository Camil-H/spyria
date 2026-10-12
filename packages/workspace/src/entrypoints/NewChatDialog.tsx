import { useQuery } from '@hq/db/react'
import { type ProjectId, projectId, type WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, Dialog, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import type { ChatKind } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'
import { offersLocalSessions, type Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'

const kindLabels: Record<ChatKind, string> = {
  channel: 'Channel',
  runtime: 'Runtime',
  local_session: 'On my machine · Claude Code subscription',
  local_codex_session: 'On my machine · Codex (ChatGPT plan)',
}

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
  const { memberId } = useSession()
  const kinds: ChatKind[] = useQuery(offersLocalSessions(workspaceId, memberId))
    ? ['channel', 'runtime', 'local_session', 'local_codex_session']
    : ['channel', 'runtime']
  const [type, setType] = useState<ChatKind>('channel')
  const [draftName, setDraftName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const chatId = await commands.createChat({ workspaceId, type, name: Name(draftName), projectId: selectedProjectId })
    onClose()
    navigate(`/w/${workspaceId}/chats/${chatId}`)
  }
  return (
    <Dialog label="New chat" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex gap-1 rounded-lg border border-line bg-app p-1">
          {kinds.map((option) => (
            <label
              key={option}
              className="relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-sm text-muted hover:bg-hover hover:text-ink has-checked:bg-selected has-checked:font-medium has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus"
            >
              <input
                type="radio"
                className="absolute inset-0 cursor-pointer opacity-0"
                name="type"
                checked={type === option}
                onChange={() => setType(option)}
              />
              {kindLabels[option]}
            </label>
          ))}
        </div>
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
