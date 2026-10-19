import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { archivedChat } from '../domain/chat.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatId: ChatId; actorId: MemberId }

export const archiveChat = ({ transactor }: Dependencies, { chatId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = archivedChat(await unitOfWork.chats.get(chatId))
    await requireChatPermission(unitOfWork.chats, chatId, actorId, 'chat.admin')
    await unitOfWork.chats.record({ type: 'chat.archived', chat, actorId })
    await unitOfWork.chatRuntimes.remove(chat.id)
  })
