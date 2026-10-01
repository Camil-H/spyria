import type { ChatId } from '@hq/kernel'
import { archiveChat } from '../operations/archive-chat.ts'
import { Dialog } from './Dialog.tsx'
import { useWorkspaceDependencies } from './providers.tsx'
import { buttonClass } from './ui.ts'

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
