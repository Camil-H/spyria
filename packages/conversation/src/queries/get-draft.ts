import type { DraftRow } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

export const getDraft =
  (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => (drafts: readonly DraftRow[]) =>
    drafts.find((draft) => draft.workspaceId === workspaceId && draft.chatId === chatId && draft.memberId === memberId)
      ?.text ?? ''
