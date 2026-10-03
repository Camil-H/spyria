import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }

export const saveDraft = ({ transactor }: Dependencies, { workspaceId, chatId, memberId, text }: Input) =>
  transactor.run((unitOfWork) =>
    text.trim() === ''
      ? unitOfWork.drafts.remove(chatId, memberId)
      : unitOfWork.drafts.save({ workspaceId, chatId, memberId, text }),
  )
