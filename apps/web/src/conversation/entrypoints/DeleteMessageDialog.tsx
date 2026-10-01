import type { MessageId } from '@hq/kernel'
import { useSession } from '../../app/session.tsx'
import { deleteMessage } from '../operations/delete-message.ts'
import { useConversationDependencies } from './providers.tsx'
import { buttonClass, ghostButtonClass } from './ui.ts'

export const DeleteMessageDialog = ({ messageId, onClose }: { messageId: MessageId; onClose: () => void }) => {
  const dependencies = useConversationDependencies()
  const { memberId } = useSession()
  const confirm = async () => {
    await deleteMessage(dependencies, { messageId, deleterId: memberId })
    onClose()
  }
  return (
    <dialog
      open
      aria-label="Delete message"
      className="fixed inset-0 z-40 m-auto flex h-fit w-80 flex-col gap-3 rounded-xl border border-line bg-raised p-5 text-ink shadow-2xl"
    >
      <h2 className="text-base font-medium">Delete message</h2>
      <button type="button" className={buttonClass} onClick={confirm}>
        Delete
      </button>
      <button type="button" className={ghostButtonClass} onClick={onClose}>
        Cancel
      </button>
    </dialog>
  )
}
