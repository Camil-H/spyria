import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import type { WorkspaceRead, WorkspaceReading } from '../domain/workspace.ts'

type Command<Input, Result = unknown> = (input: Input & { workspaceId: WorkspaceId }) => Promise<Result>

export type PanelCommands = {
  inviteMember: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  changeMemberRole: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  removeMember: Command<{ chatId: ChatId; memberId: MemberId }>
  leaveChat: Command<{ chatId: ChatId }>
  readWorkspace: Command<{ chatId: ChatId; read: WorkspaceRead; path: string }, WorkspaceReading>
  wakeWorkspace: Command<{ chatId: ChatId }>
  publishBranch: Command<
    { chatId: ChatId; action: 'push' | 'pull_request'; draft: { title: string; body: string } },
    { isRefused: boolean; text: string }
  >
}
