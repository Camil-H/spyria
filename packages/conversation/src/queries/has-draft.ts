import type { Snapshot } from '@hq/db'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'

export const hasDraft = (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.drafts.some(
    (draft) => draft.workspaceId === workspaceId && draft.chatId === chatId && draft.memberId === memberId,
  )
