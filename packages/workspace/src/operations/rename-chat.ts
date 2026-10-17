import { type ChatId, type MemberId, requireChatPermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { renamedChat } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatId: ChatId; name: Name; actorId: MemberId }

export const renameChat = ({ transactor }: Dependencies, { chatId, name, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = renamedChat(await unitOfWork.chats.get(chatId), name)
    await requireChatPermission(unitOfWork.chats, chatId, actorId, 'chat.admin')
    await unitOfWork.chats.record({ type: 'chat.renamed', chat, actorId })
  })
