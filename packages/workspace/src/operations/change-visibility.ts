import { type ChatId, type ChatVisibility, type MemberId, requireChatPermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { visibleChat } from '../domain/chat.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatId: ChatId; visibility: ChatVisibility; actorId: MemberId }

export const changeVisibility = ({ transactor }: Dependencies, { chatId, visibility, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, actorId, 'chat.admin')
    const chat = visibleChat(await unitOfWork.chats.get(chatId), visibility)
    await unitOfWork.chats.record({ type: 'chat.visibility_changed', chat, actorId })
  })
