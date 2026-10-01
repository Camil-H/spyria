import type { ChatId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { renameChat as renameChatRecord } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: Transactor }
type Input = { chatId: ChatId; name: Name }

export const renameChat = ({ transactor }: Dependencies, { chatId, name }: Input) =>
  transactor.run(async (unitOfWork) => {
    await unitOfWork.chats.save(renameChatRecord(await unitOfWork.chats.get(chatId), name))
  })
