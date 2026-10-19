import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { AlreadyParticipant, NotWorkspaceMember } from '../domain/errors.ts'
import { requireAssignableRole } from '../domain/participant.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; roleId: string; actorId: MemberId }

export const inviteMember = ({ transactor }: Dependencies, { chatId, memberId, roleId, actorId }: Input) =>
  transactor.run(async ({ chats, members }) => {
    const actorPermissions = await requireChatPermission(chats, chatId, actorId, 'members.invite')
    if (!(await members.isMember(memberId))) throw new NotWorkspaceMember()
    if (await chats.roleOf(chatId, memberId)) throw new AlreadyParticipant()
    requireAssignableRole(await chats.get(chatId), actorPermissions, roleId, await chats.role(roleId))
    await chats.changeParticipant({ type: 'member.invited', chatId, memberId, roleId, actorId })
  })
