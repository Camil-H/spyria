import { chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { AgentAvatar, focusRing, MemberAvatar } from '@spyria/ui'
import { Reply } from 'lucide-react'
import { type Ref, Suspense, use, useEffect, useState } from 'react'
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
import { MessageActions } from './MessageActions.tsx'
import { linkedMessageParam } from './message-link.ts'
import {
  ChatNameContext,
  LinkedMessageContext,
  MentionNamesContext,
  QuoteContext,
  useConversationCommands,
} from './providers.tsx'
import { threadContextOf } from './thread-context.ts'

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
  const quotes = use(QuoteContext)
  const newestReplyId = root.thread.replies.at(-1)?.id
  useEffect(() => {
    if (newestReplyId) commands.markThreadRead({ workspaceId, chatId, threadRootId: root.id })
  }, [commands, workspaceId, chatId, root.id, newestReplyId])
  return (
    <div className="mt-1 ml-1.5 flex flex-col gap-2 border-l-2 border-line pl-3">
      {root.thread.replies.length > 0 && (
        <ol aria-label="Thread replies" className="flex flex-col gap-1">
          {root.thread.replies.map((reply) => (
            <MessageItem key={reply.id} message={reply} hasMenu isChannel threadRoot={root} />
          ))}
        </ol>
      )}
      {!root.isDeleted && (
        <Composer
          workspaceId={workspaceId}
          chatId={chatId}
          threadRootId={root.id}
          quote={quotes?.quoteIn(root.id)}
          onQuoteChange={(quote) => quotes?.setQuote(root.id, quote)}
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

const QuotedMessage = ({ quote }: { quote: NonNullable<ConversationMessage['quote']> }) => (
  <Link
    to={`?${new URLSearchParams({ [linkedMessageParam]: quote.id })}`}
    className={`mt-1 flex max-w-full items-center gap-1.5 rounded-sm border-l-2 border-line pl-2 text-xs text-muted hover:text-ink ${focusRing}`}
  >
    <Reply aria-hidden size={12} className="shrink-0" />
    <span className="sr-only">{'In reply to '}</span>
    {quote.original ? (
      <>
        <span className="shrink-0 font-medium">{quote.original.authorName}</span>{' '}
        <span className={`truncate ${quote.original.isDeleted ? 'italic' : ''}`}>
          {quote.original.isDeleted ? 'This message was deleted' : quote.original.body}
        </span>
      </>
    ) : (
      <span>an earlier message</span>
    )}
  </Link>
)

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
  isChannel = false,
  threadRoot,
  onFork,
  ref,
}: {
  message: ConversationMessage
  hasMenu: boolean
  isChannel?: boolean
  threadRoot?: ThreadRoot
  onFork?: (() => Promise<unknown>) | undefined
  ref?: Ref<HTMLLIElement>
}) => {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const { thread } = message
  const [threadOpenings, setThreadOpenings] = useState(0)
  const mentionNames = use(MentionNamesContext)
  const chatName = use(ChatNameContext)
  const linkedMessageId = use(LinkedMessageContext)
  const quotes = use(QuoteContext)
  const hasLinkedReply = thread?.replies.some((reply) => reply.id === linkedMessageId) === true
  const close = () => setMode('view')
  const quotedThread = threadRoot ? [threadRoot, ...threadRoot.thread.replies] : [message, ...(thread?.replies ?? [])]
  return (
    <>
      <li
        ref={ref}
        data-message-id={message.id}
        aria-current={message.id === linkedMessageId || undefined}
        className="group relative rounded-md px-3 py-2 hover:bg-hover aria-current:bg-hover aria-current:ring-1 aria-current:ring-accent aria-current:ring-inset"
      >
        {message.kind === 'notice' ? (
          <div className="flex flex-col gap-1">
            <p className="whitespace-pre-wrap text-sm text-muted">{message.body}</p>
            {onFork && isUnreachableSessionNotice(message.body) && <ForkButton onFork={onFork} />}
          </div>
        ) : message.kind === 'step' ? (
          <AgentStep message={message} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              {message.kind === 'agent' ? (
                <AgentAvatar />
              ) : (
                <MemberAvatar name={message.authorName} image={message.authorAvatar} />
              )}
              <span className="text-sm font-medium">{message.authorName}</span>
              <time dateTime={message.createdAt.toISOString()} className="text-xs text-muted">
                {timeFormat.format(message.createdAt)}
              </time>
              {message.isEdited && !message.isDeleted && <span className="text-xs text-muted">(edited)</span>}
              {message.step?.type === 'dev_loop_prompt' && (
                <span className="text-xs text-muted">Sent by quality gates</span>
              )}
            </div>
            {message.quote && !message.isDeleted && <QuotedMessage quote={message.quote} />}
            {mode === 'edit' ? (
              <EditMessageForm messageId={message.id} initialText={message.body} onClose={close} />
            ) : message.isDeleted ? (
              <p className="text-sm text-muted italic">This message was deleted</p>
            ) : !message.isStreamed ? (
              <Suspense fallback={<p className={plainTextClassName}>{message.body}</p>}>
                <LazyMarkdown
                  text={message.body}
                  keepsLineBreaks={message.kind === 'member'}
                  mentionNames={mentionNames}
                />
              </Suspense>
            ) : (
              <p className={plainTextClassName}>{message.body}</p>
            )}
            {!message.isDeleted && mode !== 'edit' && <AttachmentList attachments={message.attachments} />}
            {message.runtimes.length > 0 && <RuntimeLinks runtimes={message.runtimes} />}
            {hasMenu && !message.isDeleted && mode !== 'edit' && (
              <MessageActions
                messageId={message.id}
                isChannel={isChannel}
                isThread={quotedThread.length > 1}
                contextText={() => threadContextOf(chatName, quotedThread)}
                canEdit={message.canEdit}
                canReply={message.canReply}
                onReplyInThread={thread ? () => setThreadOpenings(threadOpenings + 1) : undefined}
                onQuote={
                  message.canQuote && quotes
                    ? () =>
                        quotes.setQuote(threadRoot?.id ?? null, {
                          id: message.id,
                          authorName: message.authorName,
                          body: message.body,
                        })
                    : undefined
                }
                onEdit={() => setMode('edit')}
                onDelete={() => setMode('delete')}
              />
            )}
            {mode === 'delete' && <DeleteMessageDialog messageId={message.id} onClose={close} />}
          </>
        )}
      </li>
      {thread && (thread.replies.length > 0 || threadOpenings > 0) && (
        <Thread
          key={`${threadOpenings}-${hasLinkedReply}`}
          root={{ ...message, thread }}
          isInitiallyOpen={threadOpenings > 0 || hasLinkedReply}
        />
      )}
    </>
  )
}
