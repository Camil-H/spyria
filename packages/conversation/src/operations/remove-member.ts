import { type ChatId, type MemberId, requireChatPermission } from '@hq/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { NotParticipant, OwnerStays } from '../domain/errors.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; actorId: MemberId }

export const requireNonOwnerParticipant = async ({ chats }: UnitOfWork, chatId: ChatId, memberId: MemberId) => {
  if (!(await chats.roleOf(chatId, memberId))) throw new NotParticipant()
  if ((await chats.get(chatId)).ownerId === memberId) throw new OwnerStays()
}

export const removeMember = ({ transactor }: Dependencies, { chatId, memberId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, actorId, 'members.manage')
    await requireNonOwnerParticipant(unitOfWork, chatId, memberId)
    await unitOfWork.chats.changeParticipant({ type: 'member.removed', chatId, memberId, roleId: null, actorId })
  })
