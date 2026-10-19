import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { requireAssignableRole, requireNonOwner, requireParticipant } from '../domain/participant.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; roleId: string; actorId: MemberId }

export const changeMemberRole = ({ transactor }: Dependencies, { chatId, memberId, roleId, actorId }: Input) =>
  transactor.run(async ({ chats }) => {
    const actorPermissions = await requireChatPermission(chats, chatId, actorId, 'members.manage')
    requireParticipant(await chats.roleOf(chatId, memberId))
    const chat = await chats.get(chatId)
    requireNonOwner(chat, memberId)
    requireAssignableRole(chat, actorPermissions, roleId, await chats.role(roleId))
    await chats.changeParticipant({ type: 'member.role_changed', chatId, memberId, roleId, actorId })
  })
