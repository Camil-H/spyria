import type { ChatId, MemberId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { requireNonOwner, requireParticipant } from '../domain/participant.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId }

export const leaveChat = ({ transactor }: Dependencies, { chatId, memberId }: Input) =>
  transactor.run(async ({ chats }) => {
    requireParticipant(await chats.roleOf(chatId, memberId))
    requireNonOwner(await chats.get(chatId), memberId)
    await chats.changeParticipant({ type: 'member.left', chatId, memberId, roleId: null, actorId: memberId })
  })
