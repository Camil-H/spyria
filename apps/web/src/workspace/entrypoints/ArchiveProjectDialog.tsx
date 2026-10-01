import type { ProjectId } from '@hq/kernel'
import type { ChatsPolicy } from '../domain/project.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { Dialog } from './Dialog.tsx'
import { useWorkspaceDependencies } from './providers.tsx'
import { buttonClass } from './ui.ts'

export const ArchiveProjectDialog = ({ projectId, onClose }: { projectId: ProjectId; onClose: () => void }) => {
  const dependencies = useWorkspaceDependencies()
  const archiveWith = async (chatsPolicy: ChatsPolicy) => {
    await archiveProject(dependencies, { projectId, chatsPolicy })
    onClose()
  }
  return (
    <Dialog label="Archive project" onClose={onClose}>
      <button type="button" className={buttonClass} onClick={() => archiveWith('archive')}>
        Archive with its chats
      </button>
      <button type="button" className={buttonClass} onClick={() => archiveWith('release')}>
        Archive, keep chats
      </button>
    </Dialog>
  )
}
