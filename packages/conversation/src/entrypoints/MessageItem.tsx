import { focusRing } from '@hq/ui'
import { ChevronRight } from 'lucide-react'
import { type Ref, useState } from 'react'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { DeleteMessageDialog } from './DeleteMessageDialog.tsx'
import { EditMessageForm } from './EditMessageForm.tsx'
import { MessageMenu } from './MessageMenu.tsx'

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})

export const MessageItem = ({
  message,
  hasMenu,
  ref,
}: {
  message: ConversationMessage
  hasMenu: boolean
  ref?: Ref<HTMLLIElement>
}) => {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [isExpanded, setIsExpanded] = useState(false)
  const close = () => setMode('view')
  return (
    <li ref={ref} className="group relative rounded-md px-3 py-2 hover:bg-hover">
      {message.kind === 'notice' ? (
        <p className="text-sm text-muted">{message.body}</p>
      ) : message.kind === 'tool-call' ? (
        <>
          <button
            type="button"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded(!isExpanded)}
            className={`flex items-center gap-1.5 rounded-md text-sm text-muted hover:text-ink ${focusRing} aria-expanded:[&>svg]:rotate-90`}
          >
            <ChevronRight aria-hidden className="size-4 transition-transform" />
            {message.body}
          </button>
          {isExpanded && (
            <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-app p-2 text-xs">
              {message.detail}
            </pre>
          )}
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{message.authorName}</span>
            <time dateTime={message.createdAt} className="text-xs text-muted">
              {timeFormat.format(new Date(message.createdAt))}
            </time>
            {message.isEdited && !message.isDeleted && <span className="text-xs text-muted">(edited)</span>}
          </div>
          {mode === 'edit' ? (
            <EditMessageForm messageId={message.id} initialText={message.body} onClose={close} />
          ) : message.isDeleted ? (
            <p className="text-sm text-muted italic">This message was deleted</p>
          ) : (
            <p className="text-sm whitespace-pre-wrap">{message.body}</p>
          )}
          {hasMenu && !message.isDeleted && mode !== 'edit' && (
            <MessageMenu
              messageId={message.id}
              isOwn={message.isOwn}
              onEdit={() => setMode('edit')}
              onDelete={() => setMode('delete')}
            />
          )}
          {mode === 'delete' && <DeleteMessageDialog messageId={message.id} onClose={close} />}
        </>
      )}
    </li>
  )
}
