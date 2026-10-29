import { chatParticipantsIn, participantIn, type Snapshot } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

export type JoinableChat = Readonly<{
  id: ChatId
  type: 'channel' | 'runtime'
  name: string
  projectName: string | null
  memberCount: number
}>

export const listJoinableChats =
  (workspaceId: WorkspaceId, viewerId: MemberId) =>
  (snapshot: Snapshot): readonly JoinableChat[] => {
    const isParticipant = participantIn(snapshot, workspaceId, viewerId)
    return snapshot.chats
      .filter(
        (chat) =>
          chat.workspaceId === workspaceId && chat.visibility === 'public' && !chat.archived && !isParticipant(chat),
      )
      .map((chat) => ({
        id: chat.id,
        type: chat.type,
        name: chat.name,
        projectName: snapshot.projects.find((project) => project.id === chat.projectId)?.name ?? null,
        memberCount: chatParticipantsIn(snapshot, workspaceId, chat.id).length,
      }))
  }
