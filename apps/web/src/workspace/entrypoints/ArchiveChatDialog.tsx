import type { ChatId } from '@hq/kernel'
import { buttonClass, Dialog } from '@hq/ui'
import { archiveChat } from '../operations/archive-chat.ts'
import { useWorkspaceDependencies } from './providers.tsx'

export const ArchiveChatDialog = ({
  chatId,
  chatName,
  onClose,
}: {
  chatId: ChatId
  chatName: string
  onClose: () => void
}) => {
  const dependencies = useWorkspaceDependencies()
  const confirm = async () => {
    await archiveChat(dependencies, { chatId })
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
