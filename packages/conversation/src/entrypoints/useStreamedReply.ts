import { useStore } from '@hq/db/react'
import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import { useEffect, useState } from 'react'
import { type StreamedReply, streamedReplyAfter, visibleStreamedReply } from '../domain/streamed-reply.ts'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { useAgentStream } from './providers.tsx'

const replyCountIn = (messages: readonly { replyToId: string | null }[]) => (promptId: string) =>
  messages.filter((message) => message.replyToId === promptId).length

export const withStreamedReply = (
  messages: readonly ConversationMessage[],
  streamedReply: ConversationMessage | null,
) => {
  if (!streamedReply) return messages
  const threadEnd = messages.findLastIndex(
    (message) => message.id === streamedReply.replyToId || message.replyToId === streamedReply.replyToId,
  )
  return threadEnd === -1 ? [...messages, streamedReply] : messages.toSpliced(threadEnd + 1, 0, streamedReply)
}

export const useStreamedReply = (
  workspaceId: WorkspaceId,
  chatId: ChatId,
  messages: readonly ConversationMessage[],
): ConversationMessage | null => {
  const agentStream = useAgentStream()
  const store = useStore()
  const chatKey = `${workspaceId}/${chatId}`
  const [streamed, setStreamed] = useState<{ chatKey: string; reply: StreamedReply }>({ chatKey, reply: null })
  useEffect(
    () =>
      agentStream.subscribe(workspaceId, chatId, (frame) => {
        const replyCountOf = replyCountIn(store.read().messages)
        setStreamed((current) => ({
          chatKey,
          reply: streamedReplyAfter(current.chatKey === chatKey ? current.reply : null, frame, replyCountOf),
        }))
      }),
    [agentStream, store, workspaceId, chatId, chatKey],
  )
  const visible = visibleStreamedReply(streamed.chatKey === chatKey ? streamed.reply : null, replyCountIn(messages))
  if (!visible) return null
  return {
    id: messageId(`streamed-${visible.promptId}`),
    kind: 'agent',
    authorName: 'Agent',
    createdAt: messages.find((message) => message.id === visible.promptId)?.createdAt ?? new Date(0).toISOString(),
    body: visible.text,
    detail: null,
    replyToId: messageId(visible.promptId),
    isOwn: false,
    isDeleted: false,
    isEdited: false,
  }
}
