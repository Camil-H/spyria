import { inChat, memberName, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getCommits = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.commits.filter(inChat(workspaceId, chatId)).map(({ sha, message, authorId, committedAt }) => ({
    sha,
    message,
    authorName: memberName(snapshot, authorId),
    committedAt,
  }))
