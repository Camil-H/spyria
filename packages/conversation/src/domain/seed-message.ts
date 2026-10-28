import { type Attachment, fileSizeOf } from './attachments.ts'
import type { Message } from './message.ts'
import { MessageBody } from './message-body.ts'

export type QuotedMessage = Pick<Message, 'kind' | 'body' | 'attachments' | 'createdAt' | 'status'> & {
  authorName: string
}

const attachedLineOf = (attachments: readonly Attachment[]) =>
  `Attached, not readable by you: ${attachments
    .map(({ name, mediaType, size }) => `${name} (${mediaType}, ${fileSizeOf(size)})`)
    .join(', ')}`

const withAttachmentsNoted = ({ body, attachments }: Pick<Message, 'body' | 'attachments'>) =>
  attachments.length === 0 ? body : [body, attachedLineOf(attachments)].filter(Boolean).join('\n\n')

const quotedTimeOf = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const channelThreadHeaderOf = (channelName: string) =>
  `Conversation so far, from the channel thread in #${channelName}:`
export const copiedThreadHeaderOf = (channelName: string) => `Conversation from channel thread in #${channelName}`
export const runtimeChatHeaderOf = (chatName: string) => `Conversation so far, from the runtime chat ${chatName}:`

export const seedMessageBodyOf = (header: string, messages: readonly QuotedMessage[]) =>
  MessageBody(
    [
      header,
      ...messages
        .filter((message) => message.status === 'live')
        .map(
          ({ authorName, kind, createdAt, ...message }) =>
            `${authorName} (${kind === 'agent' ? 'agent' : 'member, human'}) · ${quotedTimeOf(createdAt)}\n${withAttachmentsNoted(message)}`,
        ),
    ].join('\n\n'),
  )

export const agentPromptTextOf = (
  prompt: Pick<Message, 'body' | 'attachments'>,
  seed: Pick<Message, 'body'> | undefined,
) => (seed ? `${seed.body}\n\n${withAttachmentsNoted(prompt)}` : withAttachmentsNoted(prompt))
