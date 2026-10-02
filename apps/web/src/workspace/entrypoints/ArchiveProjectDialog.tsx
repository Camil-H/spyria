import type { ProjectId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import type { ChatsPolicy } from '../domain/project.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { useWorkspaceDependencies } from './providers.tsx'

export const ArchiveProjectDialog = ({
  projectId,
  projectName,
  onClose,
}: {
  projectId: ProjectId
  projectName: string
  onClose: () => void
}) => {
  const dependencies = useWorkspaceDependencies()
  const archiveWith = async (chatsPolicy: ChatsPolicy) => {
    await archiveProject(dependencies, { projectId, chatsPolicy })
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
