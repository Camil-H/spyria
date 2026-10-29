import { Provider } from '@radix-ui/react-tooltip'
import { type MessageId, chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, IconButton, useGuardedAction } from '@spyria/ui'
import {
  Check,
  ClipboardCopy,
  Link,
  type LucideIcon,
  MessageSquareReply,
  Pencil,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { type FocusEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router'
import { messageLinkOf } from './message-link.ts'
import { useConversationCommands } from './providers.tsx'

const copyFeedbackMilliseconds = 2000

type Action = { id: string; label: string; icon: LucideIcon; disabled?: boolean; onClick: () => void }

const indexAfterKey = (key: string, index: number, count: number) =>
  ({ ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 })[key]

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
  isChannel,
  isThread,
  contextText,
  canEdit,
  canReply,
  onReplyInThread,
  onEdit,
  onDelete,
}: {
  messageId: MessageId
  isChannel: boolean
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
  const chatId = toChatId(useParams().chatId ?? '')
  const navigate = useNavigate()
  const { errorMessage, isPending, run } = useGuardedAction()
  const { feedback, copy } = useCopyFeedback()
  const link = useCopyFeedback()
  const copyLabel = `Copy ${isThread ? 'thread' : 'message'} as context`
  const isPinned = isPending || errorMessage !== null || feedback !== null || link.feedback !== null
  const [focusedIndex, setFocusedIndex] = useState(0)
  const startRuntime = () =>
    run(async () => {
      const newChatId = await commands.startRuntimeFromMessage({ workspaceId, messageId })
      navigate(`../${newChatId}`, { relative: 'path' })
    })
  const copyLinkAction: Action = {
    id: 'link',
    label:
      link.feedback === 'copied' ? 'Link copied' : link.feedback === 'failed' ? 'Copy failed' : 'Copy link to message',
    icon: link.feedback === 'copied' ? Check : Link,
    onClick: () => link.copy(messageLinkOf(window.location.origin, workspaceId, chatId, messageId)),
  }
  const channelActions: Action[] = [
    ...(onReplyInThread && canReply
      ? [{ id: 'reply', label: 'Reply in thread', icon: MessageSquareReply, onClick: onReplyInThread }]
      : []),
    {
      id: 'runtime',
      label: isPending ? 'Starting runtime…' : 'Start runtime from this message',
      icon: SquareTerminal,
      disabled: isPending,
      onClick: startRuntime,
    },
    {
      id: 'copy',
      label: feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed' : copyLabel,
      icon: feedback === 'copied' ? Check : ClipboardCopy,
      onClick: () => copy(contextText()),
    },
    copyLinkAction,
    ...(canEdit
      ? [
          { id: 'edit', label: 'Edit', icon: Pencil, onClick: onEdit },
          { id: 'delete', label: 'Delete', icon: Trash2, onClick: onDelete },
        ]
      : []),
  ]
  const actions = isChannel ? channelActions : [copyLinkAction]
  const tabStopIndex = Math.min(focusedIndex, actions.length - 1)
  const buttonsOf = (toolbar: HTMLDivElement) => [...toolbar.querySelectorAll('button')]
  const followFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = buttonsOf(event.currentTarget).indexOf(document.activeElement as HTMLButtonElement)
    if (index >= 0) setFocusedIndex(index)
  }
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextIndex = indexAfterKey(event.key, tabStopIndex, actions.length)
    if (nextIndex === undefined) return
    event.preventDefault()
    setFocusedIndex(nextIndex)
    buttonsOf(event.currentTarget)[nextIndex]?.focus()
  }
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      onFocus={followFocus}
      onKeyDown={moveFocus}
      className={`absolute top-1 right-2 flex gap-0.5 rounded-md border border-line bg-raised p-0.5 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 ${isPinned ? 'opacity-100' : 'opacity-0'}`}
    >
      <Provider delayDuration={300}>
        {actions.map((action, index) => (
          <IconButton
            key={action.id}
            isSmall
            label={action.label}
            icon={action.icon}
            disabled={action.disabled}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={action.onClick}
          />
        ))}
      </Provider>
      {errorMessage && (
        <div className="absolute top-full right-0 z-10 mt-1 w-60 rounded-md border border-line bg-raised px-2 py-1.5 shadow-lg">
          <ErrorMessage message={errorMessage} />
        </div>
      )}
    </div>
  )
}
