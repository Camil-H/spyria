import { type ChatId, chatId, type MemberId } from '@hq/kernel'
import type { IdGenerator } from '../contracts/id-generator.ts'
import type { Transactor } from '../contracts/transactor.ts'
import { startRuntimeChat } from '../domain/chat.ts'
import { Name } from '../domain/name.ts'

export type CreateChatFromChatDependencies = {
  transactor: Transactor
  idGenerator: IdGenerator
  defaultRuntimeModel: string
  defaultReasoningEffort: string
}
export type CreateChatFromChatInput = { sourceChatId: ChatId; name: string; ownerId: MemberId }

export const createChatFromChat = (
  { transactor, idGenerator, defaultRuntimeModel, defaultReasoningEffort }: CreateChatFromChatDependencies,
  { sourceChatId, name, ownerId }: CreateChatFromChatInput,
) =>
  transactor.run(async (unitOfWork) => {
    const source = await unitOfWork.chats.get(sourceChatId)
    const chat = startRuntimeChat(source, {
      id: chatId(idGenerator.next()),
      name: Name(name),
      ownerId,
      model: defaultRuntimeModel,
      reasoningEffort: defaultReasoningEffort,
    })
    await unitOfWork.chats.add(chat)
    return chat.id
  })
