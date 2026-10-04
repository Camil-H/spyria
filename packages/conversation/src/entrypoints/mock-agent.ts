import type { Snapshot, Store } from '@hq/db'
import type { ChatId, IdGenerator, MessageId } from '@hq/kernel'
import type { Clock } from '../contracts/clock.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { scriptedAgentReply } from '../domain/scripted-agent.ts'
import { appendAgentReply } from '../operations/append-agent-reply.ts'

type MockAgentDependencies = { transactor: ConversationTransactor; idGenerator: IdGenerator; clock: Clock }

export const startMockAgent = (store: Store, dependencies: MockAgentDependencies) => {
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
        .then(() => new Promise((resolve) => setTimeout(resolve, scriptedAgentReply.delayMilliseconds)))
        .then(() => appendAgentReply(dependencies, { answeredMessageId: message.id, text: scriptedAgentReply.text }))
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
