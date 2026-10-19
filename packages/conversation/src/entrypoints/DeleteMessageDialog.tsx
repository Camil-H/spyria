import type { MessageId, WorkspaceId } from '@spyria/kernel'
import { buttonClass, Dialog } from '@spyria/ui'
import { useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

export const DeleteMessageDialog = ({ messageId, onClose }: { messageId: MessageId; onClose: () => void }) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const confirm = async () => {
    await commands.deleteMessage({ workspaceId, messageId })
    onClose()
  }
  return (
    <Dialog label="Delete message" onClose={onClose}>
      <button type="button" className={buttonClass} onClick={confirm}>
        Delete
      </button>
    </Dialog>
  )
}
