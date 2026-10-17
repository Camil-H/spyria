import { chatParticipantsIn, participantIn, type Snapshot } from '@hq/db'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'

export type JoinableChannel = Readonly<{ id: ChatId; name: string; projectName: string | null; memberCount: number }>

export const listJoinableChannels =
  (workspaceId: WorkspaceId, viewerId: MemberId) =>
  (snapshot: Snapshot): readonly JoinableChannel[] => {
    const isParticipant = participantIn(snapshot, workspaceId, viewerId)
    return snapshot.chats
      .filter(
        (chat) =>
          chat.workspaceId === workspaceId &&
          chat.type === 'channel' &&
          chat.visibility === 'public' &&
          !chat.archived &&
          !isParticipant(chat),
      )
      .map((chat) => ({
        id: chat.id,
        name: chat.name,
        projectName: snapshot.projects.find((project) => project.id === chat.projectId)?.name ?? null,
        memberCount: chatParticipantsIn(snapshot, workspaceId, chat.id).length,
      }))
  }
