import type { Message } from './message.ts'
import { MessageBody } from './message-body.ts'

export type QuotedMessage = Pick<Message, 'kind' | 'body' | 'createdAt' | 'deletedAt'> & { authorName: string }

const quotedTimeOf = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const channelThreadHeaderOf = (channelName: string) =>
  `Conversation so far, from the channel thread in #${channelName}:`
export const runtimeChatHeaderOf = (chatName: string) => `Conversation so far, from the runtime chat ${chatName}:`

export const chatHistoryOf = <Quoted extends Pick<Message, 'kind'>>(messages: readonly Quoted[]) =>
  messages.filter(({ kind }) => kind === 'member' || kind === 'agent')

export const threadWrapperOf = (header: string, messages: readonly QuotedMessage[]) =>
  MessageBody(
    [
      header,
      ...messages
        .filter((message) => message.deletedAt === null)
        .map(
          ({ authorName, kind, createdAt, body }) =>
            `${authorName} (${kind === 'agent' ? 'agent' : 'member, human'}) · ${quotedTimeOf(createdAt)}\n${body}`,
        ),
    ].join('\n\n'),
  )

export const agentPromptTextOf = (prompt: Pick<Message, 'body'>, wrapper: Pick<Message, 'body'> | undefined) =>
  wrapper ? `${wrapper.body}\n\n${prompt.body}` : prompt.body
