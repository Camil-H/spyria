import type { Snapshot, Store } from '@hq/db'
import type { ChatId, MessageId } from '@hq/kernel'
import { appendAgentReply } from '../operations/append-agent-reply.ts'
import type { ConversationDependencies } from './providers.tsx'

const mockReplyText = 'Understood, working on it.'
const mockReplyDelayMilliseconds = 600

export const startMockAgent = (store: Store, dependencies: ConversationDependencies) => {
  const handledMessageIds = new Set<MessageId>()
  const lastReplyByChat = new Map<ChatId, Promise<void>>()
  let scannedMessages: Snapshot['messages'] | null = null
  const replyToPendingMessages = () => {
    const { messages } = store.read()
    if (messages === scannedMessages) return
    scannedMessages = messages
    for (const message of messages) {
      if (!message.needsReply || handledMessageIds.has(message.id)) continue
      handledMessageIds.add(message.id)
      const reply = (lastReplyByChat.get(message.chatId) ?? Promise.resolve())
        .then(() => new Promise((resolve) => setTimeout(resolve, mockReplyDelayMilliseconds)))
        .then(() => appendAgentReply(dependencies, { answeredMessageId: message.id, text: mockReplyText }))
        .then(
          () => void handledMessageIds.delete(message.id),
          (error) => console.error(error),
        )
        .finally(() => {
          if (lastReplyByChat.get(message.chatId) === reply) lastReplyByChat.delete(message.chatId)
        })
      lastReplyByChat.set(message.chatId, reply)
    }
  }
  replyToPendingMessages()
  store.subscribe(replyToPendingMessages)
}
