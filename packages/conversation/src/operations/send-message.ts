import { type ChatId, type MemberId, type MessageId, messageId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { type Attachment, maximumAttachmentsPerMessage } from '../domain/attachments.ts'
import { AttachmentNotFound, NoLlmKey, RunsOnNotChosen, TooManyAttachments } from '../domain/errors.ts'
import { newMessage, quotedMessageOf, requireNotFrozen, threadRootOf } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { noLlmKeyNoticeOf } from '../domain/model-call-failures.ts'
import { localSessionNotices, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { appendNotice } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor; limitMessage?: ((isPrompt: boolean) => void) | undefined }
type Input = {
  id: string
  chatId: ChatId
  authorId: MemberId
  text: string
  threadRootId?: MessageId | undefined
  quotedMessageId?: MessageId | undefined
  attachments?: readonly Attachment[] | undefined
}

export const sendMessage = (
  { transactor, limitMessage }: Dependencies,
  { id, chatId, authorId, text, threadRootId, quotedMessageId, attachments = [] }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    if (attachments.length > maximumAttachmentsPerMessage) throw new TooManyAttachments(maximumAttachmentsPerMessage)
    const chat = await unitOfWork.chats.get(chatId)
    const { members } = unitOfWork
    await requireChatPermission(unitOfWork.chats, chatId, authorId, 'chat.post')
    requireNotFrozen(chat)
    limitMessage?.(chat.type === 'runtime')
    const threadRoot = threadRootId ? threadRootOf(chat, chatId, await unitOfWork.messages.find(threadRootId)) : null
    const quoted = quotedMessageId ? quotedMessageOf(chatId, await unitOfWork.messages.find(quotedMessageId)) : null
    if (chat.type === 'runtime' && chat.localSession === null)
      throw new RunsOnNotChosen(runsOnWaitingNoticeOf(chat.ownerId ? await members.displayNameOf(chat.ownerId) : ''))
    if (chat.type === 'runtime' && !chat.localSession && !(await members.hasLlmCredential(authorId)))
      throw new NoLlmKey(noLlmKeyNoticeOf(await members.displayNameOf(authorId)))
    const claimed = await unitOfWork.attachments.claim(chatId, authorId, attachments)
    if (claimed.length !== attachments.length) throw new AttachmentNotFound()
    const message = newMessage({
      id: messageId(id),
      workspaceId: chat.workspaceId,
      chatId,
      kind: 'member',
      authorId,
      body: MessageBody(text, { allowsBlank: claimed.length > 0 }),
      attachments: claimed,
      createdAt: new Date(),
      replyToId: null,
      threadRootId: threadRoot,
      quotedMessageId: quoted,
    })
    if (chat.visibility === 'public') await unitOfWork.chats.join(chatId, authorId)
    await unitOfWork.messages.record({ type: 'message.posted', actorId: authorId, message })
    await unitOfWork.attachments.link(message.id, claimed)
    if (chat.localSession && authorId !== chat.ownerId)
      await appendNotice(unitOfWork, message, localSessionNotices.ownerOnly)
    else if (chat.localSession && !(await unitOfWork.chats.localSessionsAllowed()))
      await appendNotice(unitOfWork, message, localSessionNotices.turnedOff)
    else if (chat.type === 'runtime') await unitOfWork.agentJobs.prompt(message)
  })
