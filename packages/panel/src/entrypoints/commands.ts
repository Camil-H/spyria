import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'
import type { WebPage } from '../domain/browser.ts'
import type { WorkspaceRead, WorkspaceReading } from '../domain/workspace.ts'

type Command<Input, Result = unknown> = (input: Input & { workspaceId: WorkspaceId }) => Promise<Result>
export type GitActionOutcome = { isRefused: boolean; text: string; conflicts?: string[] | undefined }

export type PanelCommands = {
  inviteMember: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  changeMemberRole: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  removeMember: Command<{ chatId: ChatId; memberId: MemberId }>
  leaveChat: Command<{ chatId: ChatId }>
  readWorkspace: Command<{ chatId: ChatId; read: WorkspaceRead; path: string }, WorkspaceReading>
  wakeWorkspace: Command<{ chatId: ChatId }>
  readWebPage: Command<{ url: string }, WebPage>
  publishBranch: Command<
    { chatId: ChatId; action: 'push' | 'pull_request'; draft: { title: string; body: string } },
    { isRefused: boolean; text: string }
  >
  runGitAction: Command<{ chatId: ChatId; action: 'commit' | 'update'; message: string }, GitActionOutcome>
  sendMessage: Command<{ chatId: ChatId; text: string }>
}
