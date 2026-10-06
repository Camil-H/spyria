import { lazy, type Ref, Suspense, useState } from 'react'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { AgentStep } from './AgentStep.tsx'
import { DeleteMessageDialog } from './DeleteMessageDialog.tsx'
import { EditMessageForm } from './EditMessageForm.tsx'
import { MessageMenu } from './MessageMenu.tsx'

const Markdown = lazy(() => import('./Markdown.tsx'))
const plainTextClassName = 'text-sm whitespace-pre-wrap'

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
  const close = () => setMode('view')
  return (
    <li ref={ref} className="group relative rounded-md px-3 py-2 hover:bg-hover">
      {message.kind === 'notice' ? (
        <p className="text-sm text-muted">{message.body}</p>
      ) : message.kind === 'step' ? (
        <AgentStep message={message} />
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
          ) : message.kind === 'agent' ? (
            <Suspense fallback={<p className={plainTextClassName}>{message.body}</p>}>
              <Markdown text={message.body} />
            </Suspense>
          ) : (
            <p className={plainTextClassName}>{message.body}</p>
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
