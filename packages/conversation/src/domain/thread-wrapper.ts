import type { Message } from './message.ts'
import { MessageBody } from './message-body.ts'

export type QuotedMessage = Pick<Message, 'kind' | 'body' | 'createdAt' | 'deletedAt'> & { authorName: string }

const quotedTimeOf = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const threadWrapperOf = (channelName: string, messages: readonly QuotedMessage[]) =>
  MessageBody(
    [
      `Conversation so far, from the channel thread in #${channelName}:`,
      ...messages
        .filter((message) => message.deletedAt === null)
        .map(
          ({ authorName, kind, createdAt, body }) =>
            `${authorName} (member, ${kind === 'agent' ? 'agent' : 'human'}) · ${quotedTimeOf(createdAt)}\n${body}`,
        ),
    ].join('\n\n'),
  )

export const agentPromptTextOf = (prompt: Pick<Message, 'body'>, wrapper: Pick<Message, 'body'> | undefined) =>
  wrapper ? `${wrapper.body}\n\n${prompt.body}` : prompt.body
