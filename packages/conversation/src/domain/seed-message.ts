import { type Attachment, fileSizeOf } from './attachments.ts'
import { isDevLoopPrompt } from './dev-loop.ts'
import type { Message } from './message.ts'
import { MessageBody } from './message-body.ts'

export type QuotedMessage = Pick<Message, 'kind' | 'body' | 'attachments' | 'createdAt' | 'status'> &
  Partial<Pick<Message, 'step'>> & {
    authorName: string
  }

const describedOf = (label: string, { mediaType, size }: Attachment) => `${label} (${mediaType}, ${fileSizeOf(size)})`

const attachmentListOf = (attachments: readonly Attachment[]) =>
  attachments.map((attachment) => describedOf(attachment.name, attachment)).join(', ')

const attachedLineOf = (attachments: readonly Attachment[]) =>
  attachments.length === 0 ? '' : `Attached, not readable by you: ${attachmentListOf(attachments)}`

const withAttachmentsNoted = ({ body, attachments }: Pick<Message, 'body' | 'attachments'>) =>
  [body, attachedLineOf(attachments)].filter(Boolean).join('\n\n')

const savedLineOf = (saved: readonly (Attachment & { path: string })[]) =>
  saved.length === 0
    ? ''
    : `Attached files, saved in your workspace: ${saved.map((attachment) => describedOf(attachment.path, attachment)).join(', ')}`

const withPromptAttachmentsNoted = (
  { body, attachments }: Pick<Message, 'body' | 'attachments'>,
  savedPaths: ReadonlyMap<string, string>,
) => {
  const saved = attachments.flatMap((attachment) => {
    const path = savedPaths.get(attachment.id)
    return path ? [{ ...attachment, path }] : []
  })
  const unsaved = attachments.filter((attachment) => !savedPaths.has(attachment.id))
  return [body, savedLineOf(saved), attachedLineOf(unsaved)].filter(Boolean).join('\n\n')
}

const quotedTimeOf = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const channelThreadHeaderOf = (channelName: string) =>
  `Conversation so far, from the channel thread in #${channelName}:`
export const copiedThreadHeaderOf = (channelName: string) => `Conversation from channel thread in #${channelName}`
export const runtimeChatHeaderOf = (chatName: string) => `Conversation so far, from the runtime chat ${chatName}:`

const speakerKindOf = (message: QuotedMessage) =>
  message.kind === 'agent' ? 'agent' : isDevLoopPrompt(message) ? 'automatic prompt' : 'member, human'

const speakerOf = (message: QuotedMessage) =>
  `${message.authorName} (${speakerKindOf(message)}) · ${quotedTimeOf(message.createdAt)}`

export const seedMessageBodyOf = (header: string, messages: readonly QuotedMessage[]) =>
  MessageBody(
    [
      header,
      ...messages
        .filter((message) => message.status === 'live')
        .map((message) => `${speakerOf(message)}\n${withAttachmentsNoted(message)}`),
    ].join('\n\n'),
  )

const inReplyToOf = (quoted: QuotedMessage) =>
  `In reply to ${speakerOf(quoted)}:\n${withAttachmentsNoted(quoted).replace(/^/gm, '> ')}`

export const agentPromptTextOf = (
  prompt: Pick<Message, 'body' | 'attachments'>,
  seed: Pick<Message, 'body'> | undefined,
  quoted?: QuotedMessage | undefined,
  savedPaths: ReadonlyMap<string, string> = new Map(),
) =>
  [
    ...(seed ? [seed.body] : []),
    ...(quoted?.status === 'live' ? [inReplyToOf(quoted)] : []),
    withPromptAttachmentsNoted(prompt, savedPaths),
  ].join('\n\n')
