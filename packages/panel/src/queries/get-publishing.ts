import { findChat, inChat, type Snapshot } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

const openStates = ['open', 'draft']

export const getPublishing = (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  const card = snapshot.messages
    .filter((message) => inChat(workspaceId, chatId)(message) && message.step?.type === 'pull_request')
    .reduce<Snapshot['messages'][number] | undefined>(
      (latest, message) => (latest && latest.seq > message.seq ? latest : message),
      undefined,
    )
  return {
    canPublish: chat !== undefined && chat.repository !== null && chat.ownerId === viewerId,
    chatName: chat?.name ?? '',
    hasOpenPullRequest: openStates.includes(String(card?.step?.state)),
    isTurnRunning: Boolean(chat?.agentTurnMessageId),
    workingBranch: chat?.gitBranch ?? null,
    baseBranch: chat?.baseBranch ?? null,
  }
}
