import { type ChatId, type MemberId, requireChatPermission } from '@hq/kernel'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { NotForkable } from '../domain/errors.ts'
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
  })
