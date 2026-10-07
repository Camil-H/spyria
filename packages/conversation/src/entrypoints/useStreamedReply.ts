import { useStore } from '@hq/db/react'
import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import { useEffect, useState } from 'react'
import {
  type StreamedReply,
  storedStreamedReply,
  streamedReplyAfter,
  visibleStreamedReply,
} from '../domain/streamed-reply.ts'
import type { ConversationItem, ConversationMessage } from '../queries/get-conversation.ts'
import { useAgentStream } from './providers.tsx'

const replyCountIn = (messages: readonly { replyToId: string | null }[]) => (promptId: string) =>
  messages.filter((message) => message.replyToId === promptId).length

export const withStreamedReply = (
  items: readonly ConversationItem[],
  streamedReply: ConversationMessage | null,
): readonly ConversationItem[] => {
  if (!streamedReply) return items
  const threadEnd = items.findLastIndex(
    (item) =>
      item.type === 'message' &&
      (item.message.id === streamedReply.replyToId || item.message.replyToId === streamedReply.replyToId),
  )
  const streamed = { type: 'message', message: streamedReply } as const
  return threadEnd === -1 ? [...items, streamed] : items.toSpliced(threadEnd + 1, 0, streamed)
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
        setStreamed((current) => {
          const reply = current.chatKey === chatKey ? current.reply : null
          return {
            chatKey,
            reply:
              'storedId' in frame ? storedStreamedReply(reply, frame) : streamedReplyAfter(reply, frame, replyCountOf),
          }
        })
      }),
    [agentStream, store, workspaceId, chatId, chatKey],
  )
  const visible = visibleStreamedReply(
    streamed.chatKey === chatKey ? streamed.reply : null,
    replyCountIn(messages),
    (storedId) => messages.some((message) => message.id === storedId),
  )
  if (!visible) return null
  return {
    id: messageId(`streamed-${visible.promptId}`),
    kind: visible.isReasoning ? 'step' : 'agent',
    authorName: 'Agent',
    createdAt: messages.find((message) => message.id === visible.promptId)?.createdAt ?? new Date(0).toISOString(),
    body: visible.text,
    step: visible.isReasoning ? { type: 'thought', text: visible.text, durationMilliseconds: null } : null,
    replyToId: messageId(visible.promptId),
    isOwn: false,
    isDeleted: false,
    isEdited: false,
    isRunning: true,
    canConnectTools: false,
  }
}
