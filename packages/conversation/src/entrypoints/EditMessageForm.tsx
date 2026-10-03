import type { MessageId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { buttonClass, fieldClass, ghostButtonClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { editMessage } from '../operations/edit-message.ts'
import { useConversationDependencies } from './providers.tsx'

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

export const EditMessageForm = ({
  messageId,
  initialText,
  onClose,
}: {
  messageId: MessageId
  initialText: string
  onClose: () => void
}) => {
  const dependencies = useConversationDependencies()
  const { memberId } = useSession()
  const [text, setText] = useState(initialText)
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    await editMessage(dependencies, { messageId, editorId: memberId, text })
    onClose()
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <textarea
        ref={focusOnMount}
        aria-label="Edit message"
        rows={2}
        className={`${fieldClass} resize-none field-sizing-content`}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={text.trim() === ''}>
          Save
        </button>
        <button type="button" className={ghostButtonClass} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
