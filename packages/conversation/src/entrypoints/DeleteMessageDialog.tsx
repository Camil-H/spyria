import type { MessageId, WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, Dialog } from '@hq/ui'
import { useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

export const DeleteMessageDialog = ({ messageId, onClose }: { messageId: MessageId; onClose: () => void }) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const confirm = async () => {
    await commands.deleteMessage({ workspaceId, messageId, deleterId: memberId })
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
