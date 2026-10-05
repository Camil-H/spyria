import type { Conversation } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'

const scrollIntoView = (element: HTMLElement | null) => element?.scrollIntoView({ block: 'end' })

export const MessageList = ({ conversation }: { conversation: Conversation }) => (
  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
    {conversation.messages.length === 0 ? (
      <p className="px-3 py-2 text-sm text-muted">No messages yet</p>
    ) : (
      <ol aria-label="Messages" className="flex flex-col gap-1">
        {conversation.messages.map((message, index) => (
          <MessageItem
            key={message.id}
            message={message}
            hasMenu={conversation.type === 'channel'}
            ref={index === conversation.messages.length - 1 ? scrollIntoView : undefined}
          />
        ))}
      </ol>
    )}
    {conversation.isAgentWorking && (
      <div
        ref={scrollIntoView}
        role="status"
        aria-label="Agent is working"
        className="flex items-center gap-2 px-3 py-2 text-sm text-muted"
      >
        <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
        Agent is working…
      </div>
    )}
  </div>
)
