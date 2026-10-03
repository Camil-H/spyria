import type { Conversation } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'
import { WorkingIndicator } from './WorkingIndicator.tsx'

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
            isLast={index === conversation.messages.length - 1}
          />
        ))}
      </ol>
    )}
    {conversation.isAgentWorking && <WorkingIndicator />}
  </div>
)
