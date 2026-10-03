import type { MessageId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, Dialog } from '@hq/ui'
import { deleteMessage } from '../operations/delete-message.ts'
import { useConversationDependencies } from './providers.tsx'

export const DeleteMessageDialog = ({ messageId, onClose }: { messageId: MessageId; onClose: () => void }) => {
  const dependencies = useConversationDependencies()
  const { memberId } = useSession()
  const confirm = async () => {
    await deleteMessage(dependencies, { messageId, deleterId: memberId })
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
