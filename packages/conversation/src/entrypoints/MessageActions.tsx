import { Provider } from '@radix-ui/react-tooltip'
import type { MessageId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, IconButton, useGuardedAction } from '@spyria/ui'
import { Check, ClipboardCopy, MessageSquareReply, Pencil, SquareTerminal, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import { useConversationCommands } from './providers.tsx'

const copyFeedbackMilliseconds = 2000

const useCopyFeedback = () => {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (feedback === null) return
    const timer = setTimeout(setFeedback, copyFeedbackMilliseconds, null)
    return () => clearTimeout(timer)
  }, [feedback])
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => setFeedback('copied'),
      () => setFeedback('failed'),
    )
  return { feedback, copy }
}

export const MessageActions = ({
  messageId,
  isThread,
  contextText,
  canEdit,
  canReply,
  onReplyInThread,
  onEdit,
  onDelete,
}: {
  messageId: MessageId
  isThread: boolean
  contextText: () => string
  canEdit: boolean
  canReply: boolean
  onReplyInThread: (() => void) | undefined
  onEdit: () => void
  onDelete: () => void
}) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const navigate = useNavigate()
  const { errorMessage, isPending, run } = useGuardedAction()
  const { feedback, copy } = useCopyFeedback()
  const copyLabel = `Copy ${isThread ? 'thread' : 'message'} as context`
  const isPinned = isPending || errorMessage !== null || feedback !== null
  const startRuntime = () =>
    run(async () => {
      const newChatId = await commands.startRuntimeFromMessage({ workspaceId, messageId })
      navigate(`../${newChatId}`, { relative: 'path' })
    })
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={`absolute top-1 right-2 flex gap-0.5 rounded-md border border-line bg-raised p-0.5 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 ${isPinned ? 'opacity-100' : 'opacity-0'}`}
    >
      <Provider delayDuration={300}>
        {onReplyInThread && canReply && (
          <IconButton isSmall label="Reply in thread" icon={MessageSquareReply} onClick={onReplyInThread} />
        )}
        <IconButton
          isSmall
          label={isPending ? 'Starting runtime…' : 'Start runtime from this message'}
          icon={SquareTerminal}
          disabled={isPending}
          onClick={startRuntime}
        />
        <IconButton
          isSmall
          label={feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : copyLabel}
          icon={feedback === 'copied' ? Check : ClipboardCopy}
          onClick={() => copy(contextText())}
        />
        {canEdit && <IconButton isSmall label="Edit" icon={Pencil} onClick={onEdit} />}
        {canEdit && <IconButton isSmall label="Delete" icon={Trash2} onClick={onDelete} />}
      </Provider>
      {errorMessage && (
        <div className="absolute top-full right-0 z-10 mt-1 w-60 rounded-md border border-line bg-raised px-2 py-1.5 shadow-lg">
          <ErrorMessage message={errorMessage} />
        </div>
      )}
    </div>
  )
}
