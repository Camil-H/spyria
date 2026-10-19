import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { PublicChatOpenToAll } from '../domain/errors.ts'
import { requireNonOwner, requireParticipant } from '../domain/participant.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; actorId: MemberId }

export const removeMember = ({ transactor }: Dependencies, { chatId, memberId, actorId }: Input) =>
  transactor.run(async ({ chats }) => {
    await requireChatPermission(chats, chatId, actorId, 'members.manage')
    requireParticipant(await chats.roleOf(chatId, memberId))
    const chat = await chats.get(chatId)
    requireNonOwner(chat, memberId)
    if (chat.visibility === 'public') throw new PublicChatOpenToAll()
    await chats.changeParticipant({ type: 'member.removed', chatId, memberId, roleId: null, actorId })
  })
