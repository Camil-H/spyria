import { MessageBody } from '../domain/message-body.ts'
import { copiedThreadHeaderOf, type QuotedMessage, seedMessageBodyOf } from '../domain/seed-message.ts'
import type { ConversationMessage } from '../queries/get-conversation.ts'

const quotedOf = (message: ConversationMessage): QuotedMessage => ({
  kind: message.kind,
  body: MessageBody(message.body, { allowsBlank: true }),
  attachments: message.attachments,
  createdAt: new Date(message.createdAt),
  status: message.isDeleted ? 'deleted' : 'live',
  authorName: message.authorName,
})

export const threadContextOf = (channelName: string, thread: readonly ConversationMessage[]) =>
  seedMessageBodyOf(copiedThreadHeaderOf(channelName), thread.map(quotedOf))
