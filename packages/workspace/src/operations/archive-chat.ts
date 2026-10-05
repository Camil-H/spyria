import type { ChatId, MemberId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { archivedChat } from '../domain/chat.ts'

type Dependencies = { transactor: Transactor }
type Input = { chatId: ChatId; actorId: MemberId }

export const archiveChat = ({ transactor }: Dependencies, { chatId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = archivedChat(await unitOfWork.chats.get(chatId))
    await unitOfWork.chats.record({ type: 'chat.archived', chat, actorId })
    await unitOfWork.chatRuntimes.remove(chat.id)
  })
