import { type ChatId, type MemberId, type MessageId, messageId, requireChatPermission } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { NoLlmKey, RunsOnNotChosen } from '../domain/errors.ts'
import { newMessage, threadRootOf } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { noLlmKeyNoticeOf } from '../domain/model-call-failures.ts'
import { localSessionNotices, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { appendNotice } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { id: string; chatId: ChatId; authorId: MemberId; text: string; threadRootId?: MessageId | undefined }

export const sendMessage = ({ transactor }: Dependencies, { id, chatId, authorId, text, threadRootId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = await unitOfWork.chats.get(chatId)
    const { members } = unitOfWork
    await requireChatPermission(unitOfWork.chats, chatId, authorId, 'chat.post')
    const threadRoot = threadRootId ? threadRootOf(chat, chatId, await unitOfWork.messages.find(threadRootId)) : null
    if (chat.type === 'runtime' && chat.localSession === null)
      throw new RunsOnNotChosen(runsOnWaitingNoticeOf(chat.ownerId ? await members.displayNameOf(chat.ownerId) : ''))
    if (chat.type === 'runtime' && !chat.localSession && !(await members.hasLlmCredential(authorId)))
      throw new NoLlmKey(noLlmKeyNoticeOf(await members.displayNameOf(authorId)))
    const message = newMessage({
      id: messageId(id),
      workspaceId: chat.workspaceId,
      chatId,
      kind: 'member',
      authorId,
      body: MessageBody(text),
      createdAt: new Date(),
      replyToId: null,
      threadRootId: threadRoot,
    })
    await unitOfWork.chats.join(chatId, authorId)
    await unitOfWork.messages.record({ type: 'message.posted', actorId: authorId, message })
    if (chat.localSession && authorId !== chat.ownerId)
      await appendNotice(unitOfWork, message, localSessionNotices.ownerOnly)
    else if (chat.localSession && !(await unitOfWork.chats.localSessionsAllowed()))
      await appendNotice(unitOfWork, message, localSessionNotices.turnedOff)
    else if (chat.type === 'runtime') await unitOfWork.agentJobs.prompt(message)
  })
