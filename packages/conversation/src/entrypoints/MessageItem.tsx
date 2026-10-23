import { chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { type Ref, Suspense, useEffect, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router'
import { isUnreachableSessionNotice } from '../domain/session-routing.ts'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { AgentStep } from './AgentStep.tsx'
import { Composer } from './Composer.tsx'
import { DeleteMessageDialog } from './DeleteMessageDialog.tsx'
import { Disclosure } from './Disclosure.tsx'
import { EditMessageForm } from './EditMessageForm.tsx'
import { ForkButton } from './ForkButton.tsx'
import { LazyMarkdown } from './LazyMarkdown.tsx'
import { AttachmentList } from './Media.tsx'
import { MessageMenu } from './MessageMenu.tsx'
import { useConversationCommands } from './providers.tsx'

const plainTextClassName = 'text-sm whitespace-pre-wrap'

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})

type ThreadRoot = ConversationMessage & { thread: NonNullable<ConversationMessage['thread']> }

const OpenThread = ({ root }: { root: ThreadRoot }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const chatId = toChatId(useParams().chatId ?? '')
  const commands = useConversationCommands()
  const newestReplyId = root.thread.replies.at(-1)?.id
  useEffect(() => {
    if (newestReplyId) commands.markThreadRead({ workspaceId, chatId, threadRootId: root.id })
  }, [commands, workspaceId, chatId, root.id, newestReplyId])
  return (
    <div className="mt-1 ml-1.5 flex flex-col gap-2 border-l-2 border-line pl-3">
      {root.thread.replies.length > 0 && (
        <ol aria-label="Thread replies" className="flex flex-col gap-1">
          {root.thread.replies.map((reply) => (
            <MessageItem key={reply.id} message={reply} hasMenu />
          ))}
        </ol>
      )}
      {!root.isDeleted && (
        <Composer
          workspaceId={workspaceId}
          chatId={chatId}
          threadRootId={root.id}
          isBlocked={!root.canReply}
          blockedNotice="You can read this chat"
        />
      )}
    </div>
  )
}

const RuntimeLinks = ({ runtimes }: { runtimes: ConversationMessage['runtimes'] }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  return runtimes.map(({ chatId, startedByName, name }) =>
    name ? (
      <Link key={chatId} to={`/w/${workspaceId}/chats/${chatId}`} className="mt-1 block text-xs text-muted underline">
        Runtime: {name}
      </Link>
    ) : (
      <p key={chatId} className="mt-1 text-xs text-muted">
        {startedByName} started a runtime
      </p>
    ),
  )
}

const Thread = ({ root, isInitiallyOpen }: { root: ThreadRoot; isInitiallyOpen: boolean }) => {
  const { replies, newCount } = root.thread
  return (
    <li className="px-3">
      <Disclosure
        label={`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}${newCount > 0 ? ` · ${newCount} new` : ''}`}
        isInitiallyOpen={isInitiallyOpen}
      >
        <OpenThread root={root} />
      </Disclosure>
    </li>
  )
}

export const MessageItem = ({
  message,
  hasMenu,
  onFork,
  ref,
}: {
  message: ConversationMessage
  hasMenu: boolean
  onFork?: (() => Promise<unknown>) | undefined
  ref?: Ref<HTMLLIElement>
}) => {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [threadOpenings, setThreadOpenings] = useState(0)
  const close = () => setMode('view')
  const { thread } = message
  return (
    <>
      <li ref={ref} className="group relative rounded-md px-3 py-2 hover:bg-hover">
        {message.kind === 'notice' ? (
          <div className="flex flex-col gap-1">
            <p className="whitespace-pre-wrap text-sm text-muted">{message.body}</p>
            {onFork && isUnreachableSessionNotice(message.body) && <ForkButton onFork={onFork} />}
          </div>
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
            ) : !message.isStreamed ? (
              <Suspense fallback={<p className={plainTextClassName}>{message.body}</p>}>
                <LazyMarkdown text={message.body} />
              </Suspense>
            ) : (
              <p className={plainTextClassName}>{message.body}</p>
            )}
            {!message.isDeleted && mode !== 'edit' && <AttachmentList attachments={message.attachments} />}
            {message.runtimes.length > 0 && <RuntimeLinks runtimes={message.runtimes} />}
            {hasMenu && !message.isDeleted && mode !== 'edit' && (
              <MessageMenu
                messageId={message.id}
                canEdit={message.canEdit}
                canReply={message.canReply}
                onReplyInThread={thread ? () => setThreadOpenings(threadOpenings + 1) : undefined}
                onEdit={() => setMode('edit')}
                onDelete={() => setMode('delete')}
              />
            )}
            {mode === 'delete' && <DeleteMessageDialog messageId={message.id} onClose={close} />}
          </>
        )}
      </li>
      {thread && (thread.replies.length > 0 || threadOpenings > 0) && (
        <Thread key={threadOpenings} root={{ ...message, thread }} isInitiallyOpen={threadOpenings > 0} />
      )}
    </>
  )
}
