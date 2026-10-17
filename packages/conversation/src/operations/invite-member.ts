import { type ChatId, canGrant, isRoleAllowedIn, type MemberId, requireChatPermission } from '@hq/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  AlreadyParticipant,
  NotWorkspaceMember,
  OwnerRoleNotAssignable,
  PublicChatOpenToAll,
  RoleAboveOwn,
  RoleNotFound,
} from '../domain/errors.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; roleId: string; actorId: MemberId }

export const requireAssignableRole = async (
  { chats }: UnitOfWork,
  chatId: ChatId,
  actorId: MemberId,
  roleId: string,
) => {
  if (roleId === 'owner') throw new OwnerRoleNotAssignable()
  const role = await chats.role(roleId)
  if (!role) throw new RoleNotFound(roleId)
  if (!canGrant(await chats.permissions(chatId, actorId), role)) throw new RoleAboveOwn()
  if (!isRoleAllowedIn(await chats.get(chatId), role)) throw new PublicChatOpenToAll()
}

export const inviteMember = ({ transactor }: Dependencies, { chatId, memberId, roleId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const { chats } = unitOfWork
    await requireChatPermission(chats, chatId, actorId, 'members.invite')
    if (!(await unitOfWork.members.isMember(memberId))) throw new NotWorkspaceMember()
    if (await chats.roleOf(chatId, memberId)) throw new AlreadyParticipant()
    await requireAssignableRole(unitOfWork, chatId, actorId, roleId)
    await chats.changeParticipant({ type: 'member.invited', chatId, memberId, roleId, actorId })
  })
