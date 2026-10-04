import type { ChatId, WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import { useWorkspaceCommands } from './providers.tsx'

export const ArchiveChatDialog = ({
  workspaceId,
  chatId,
  chatName,
  onClose,
}: {
  workspaceId: WorkspaceId
  chatId: ChatId
  chatName: string
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const confirm = async () => {
    await commands.archiveChat({ workspaceId, chatId })
    onClose()
  }
  return (
    <Dialog label="Archive chat" subject={chatName} onClose={onClose}>
      <button type="button" className={buttonClass} onClick={confirm}>
        Archive
      </button>
    </Dialog>
  )
}
