import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<unknown>

export type PanelCommands = {
  inviteMember: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  changeMemberRole: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  removeMember: Command<{ chatId: ChatId; memberId: MemberId }>
  leaveChat: Command<{ chatId: ChatId }>
}
