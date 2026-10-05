import type { ChatId, MemberId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId }

export const markChatRead = ({ transactor }: Dependencies, { chatId, memberId }: Input) =>
  transactor.run((unitOfWork) => unitOfWork.readMarkers.markNewestRead(chatId, memberId))
