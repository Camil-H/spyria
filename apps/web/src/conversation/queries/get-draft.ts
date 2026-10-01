import type { Snapshot } from '@hq/db'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'

export const getDraft = (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.drafts.find(
    (draft) => draft.workspaceId === workspaceId && draft.chatId === chatId && draft.memberId === memberId,
  )?.text ?? ''
