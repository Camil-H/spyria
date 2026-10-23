import type { ChatId, MemberId, MessageId, WorkspaceId } from '@spyria/kernel'
import type { Attachment } from '../domain/attachments.ts'
import type { GitAction, GitActionOutcome } from '../domain/git-actions.ts'
import type { PublishAction, PullRequestDraft } from '../domain/pull-requests.ts'
import type { RunsOn } from '../domain/session-routing.ts'
import type {
  CommandOutputFrame,
  DelegatedFrame,
  QuestionFrame,
  StoredFrame,
  StreamFrame,
  WorkspaceFrame,
} from '../domain/streamed-reply.ts'
import type { WorkspaceRead, WorkspaceReading } from '../domain/workspace-reads.ts'
import type { ChatRoutingRead } from '../queries/get-chat-routing.ts'
import type { QuestionAnswer } from './endpoints.ts'

type Command<Input, Result = string> = (input: Input & { workspaceId: WorkspaceId }) => Promise<Result>

export type ConversationCommands = {
  sendMessage: Command<{
    chatId: ChatId
    text: string
    threadRootId?: MessageId | undefined
    attachments?: readonly Attachment[] | undefined
  }>
  uploadAttachment: Command<{ chatId: ChatId; file: File }, Attachment>
  readMedia: Command<{ path: string }, Blob>
  editMessage: Command<{ messageId: MessageId; text: string }>
  deleteMessage: Command<{ messageId: MessageId }>
  markChatRead: Command<{ chatId: ChatId }>
  markThreadRead: Command<{ chatId: ChatId; threadRootId: MessageId }>
  stopAgent: Command<{ chatId: ChatId }>
  retryAgent: Command<{ chatId: ChatId }>
  startRuntimeFromMessage: Command<{ messageId: MessageId }>
  forkChat: Command<{ sourceChatId: ChatId }>
  inviteMember: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  changeMemberRole: Command<{ chatId: ChatId; memberId: MemberId; roleId: string }>
  removeMember: Command<{ chatId: ChatId; memberId: MemberId }>
  joinChannel: Command<{ chatId: ChatId }>
  leaveChat: Command<{ chatId: ChatId }>
  saveDraft: Command<{ chatId: ChatId; text: string }, void>
  commandOutput: Command<{ chatId: ChatId; stepId: string }>
  connectTool: Command<{ tool: string }, unknown>
  updateChatRouting: Command<{
    chatId: ChatId
    sessionModel?: string
    subagentPolicy?: 'auto' | 'same_as_main'
    runsOn?: RunsOn
    adapterModel?: string
    reasoningEffort?: string
  }>
  chatRouting: Command<{ chatId: ChatId }, ChatRoutingRead>
  answerQuestion: Command<{ chatId: ChatId; questionId: string; answer: QuestionAnswer }, number>
  readWorkspace: Command<{ chatId: ChatId; read: WorkspaceRead; path: string }, WorkspaceReading>
  wakeWorkspace: Command<{ chatId: ChatId }, void>
  publishBranch: Command<
    { chatId: ChatId; action: PublishAction; draft: PullRequestDraft },
    { isRefused: boolean; text: string }
  >
  runGitAction: Command<{ chatId: ChatId; action: GitAction; message: string }, GitActionOutcome>
}

export type AgentStream = {
  subscribe(
    workspaceId: WorkspaceId,
    chatId: ChatId,
    listener: (
      frame: StreamFrame | StoredFrame | QuestionFrame | WorkspaceFrame | DelegatedFrame | CommandOutputFrame,
    ) => void,
  ): () => void
}
