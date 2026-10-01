import type { ChatId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { archiveChat as archiveChatRecord } from '../domain/chat.ts'

type Dependencies = { transactor: Transactor }
type Input = { chatId: ChatId }

export const archiveChat = ({ transactor }: Dependencies, { chatId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await unitOfWork.chats.save(archiveChatRecord(await unitOfWork.chats.get(chatId)))
  })
