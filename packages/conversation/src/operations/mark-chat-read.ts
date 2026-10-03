import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { advancedReadMarker } from '../domain/read-marker.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId }

export const markChatRead = ({ transactor }: Dependencies, { workspaceId, chatId, memberId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const lastReadMessageId = await unitOfWork.readMarkers.get(chatId, memberId)
    const newestMessageId = advancedReadMarker(lastReadMessageId, await unitOfWork.messages.idsInChat(chatId))
    if (newestMessageId && newestMessageId !== lastReadMessageId)
      await unitOfWork.readMarkers.save({ workspaceId, memberId, chatId, lastReadMessageId: newestMessageId })
  })
