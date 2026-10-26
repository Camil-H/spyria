import { type ChatId, type MemberId, messageId, requireChatPermission } from '@spyria/kernel'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { NotForkable } from '../domain/errors.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { isOpenPullRequest, keepsSourceBranch } from '../domain/pull-requests.ts'
import { runtimeChatHeaderOf } from '../domain/seed-message.ts'
import { seedRuntimeChat } from './seed-runtime-chat.ts'

type Dependencies = { transactor: ConversationTransactor; runtimeChatStarter: RuntimeChatStarter }
type Input = { id: string; chatId: ChatId; sourceChatId: ChatId; memberId: MemberId }

export const forkChat = (
  { transactor, runtimeChatStarter }: Dependencies,
  { id, chatId, sourceChatId, memberId }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, sourceChatId, memberId, 'chat.read')
    const source = await unitOfWork.chats.get(sourceChatId)
    if (source.type !== 'runtime') throw new NotForkable()
    await seedRuntimeChat(unitOfWork, runtimeChatStarter, {
      id,
      workspaceId: source.workspaceId,
      chatId,
      sourceChatId,
      name: `${source.name} (fork)`,
      memberId,
      header: runtimeChatHeaderOf(source.name),
      quoted: await unitOfWork.messages.history(sourceChatId),
    })
    const card = keepsSourceBranch(source, memberId)
      ? await unitOfWork.messages.pullRequestCard(sourceChatId)
      : undefined
    if (card?.step?.type !== 'pull_request' || !isOpenPullRequest(card.step)) return
    await unitOfWork.messages.record({
      type: 'message.posted',
      actorId: memberId,
      message: newMessage({
        id: messageId(`${id}-pull-request`),
        workspaceId: source.workspaceId,
        chatId,
        kind: 'step',
        authorId: memberId,
        body: MessageBody(card.step.type),
        step: card.step,
        createdAt: new Date(),
        replyToId: null,
      }),
    })
  })
