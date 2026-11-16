import { type ChatId, chatId, type MemberId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { startRuntimeChat } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; sourceChatId: ChatId; name: string; ownerId: MemberId; keepsBranch: boolean }

export const createChatFromChat = (
  { transactor }: Dependencies,
  { id, sourceChatId, name, ownerId, keepsBranch }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    const chat = startRuntimeChat(
      await unitOfWork.chats.get(sourceChatId),
      { id: chatId(id), name: Name(name), ownerId },
      keepsBranch,
    )
    await unitOfWork.chats.record({ type: 'chat.created', chat, actorId: ownerId })
  })
