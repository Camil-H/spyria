import type { MessageId, WorkspaceId } from '@spyria/kernel'
import { buttonClass, fieldClass, ghostButtonClass } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

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
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const [text, setText] = useState(initialText)
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    await commands.editMessage({ workspaceId, messageId, text })
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
