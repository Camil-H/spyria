import type { ChatId, ChatVisibility, MemberId, ProjectId, WorkspaceId } from '@hq/kernel'
import type { Chat } from '../domain/chat.ts'
import type { WorkspaceRole } from '../domain/member.ts'
import type { Name } from '../domain/name.ts'
import type { ChatsPolicy } from '../domain/project.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<string>

export type WorkspaceCommands = {
  createProject: Command<{ name: Name }>
  createChat: Command<{ type: Chat['type']; visibility?: ChatVisibility; name: Name; projectId: ProjectId | null }>
  moveChat: Command<{ chatId: ChatId; projectId: ProjectId | null }>
  archiveChat: Command<{ chatId: ChatId }>
  archiveProject: Command<{ projectId: ProjectId; chatsPolicy: ChatsPolicy }>
  renameChat: Command<{ chatId: ChatId; name: Name }>
  changeVisibility: Command<{ chatId: ChatId; visibility: ChatVisibility }>
  joinChannel: Command<{ chatId: ChatId }>
  leaveChat: Command<{ chatId: ChatId }>
  renameProject: Command<{ projectId: ProjectId; name: Name }>
  createWorkspace: Command<{ name: Name }>
  inviteMember: Command<{ email: string; role: WorkspaceRole }>
  revokeInvite: Command<{ invitationId: string }>
  changeMemberRole: Command<{ memberId: MemberId; role: WorkspaceRole }>
  removeMember: Command<{ memberId: MemberId }>
  transferChat: Command<{ chatId: ChatId; ownerId: MemberId }>
}
