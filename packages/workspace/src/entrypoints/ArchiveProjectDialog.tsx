import type { ProjectId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import type { ChatsPolicy } from '../domain/project.ts'
import { useWorkspaceCommands } from './providers.tsx'

export const ArchiveProjectDialog = ({
  workspaceId,
  projectId,
  projectName,
  onClose,
}: {
  workspaceId: WorkspaceId
  projectId: ProjectId
  projectName: string
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const archiveWith = async (chatsPolicy: ChatsPolicy) => {
    await commands.archiveProject({ workspaceId, projectId, chatsPolicy })
    onClose()
  }
  return (
    <Dialog label="Archive project" subject={projectName} onClose={onClose}>
      <button type="button" className={buttonClass} onClick={() => archiveWith('archive')}>
        Archive with its chats
      </button>
      <button type="button" className={buttonClass} onClick={() => archiveWith('release')}>
        Archive, keep chats
      </button>
    </Dialog>
  )
}
