import type { ChatId, MemberId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatIds: readonly ChatId[]; actorId: MemberId }

export const reorderChats = ({ transactor }: Dependencies, { chatIds, actorId }: Input) =>
  transactor.run((unitOfWork) => unitOfWork.chats.placeInSidebar({ memberId: actorId, chatIds }))
