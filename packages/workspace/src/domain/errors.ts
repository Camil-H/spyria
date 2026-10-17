import { DomainError, errorKind } from '@hq/kernel'

export class WorkspaceError extends DomainError {}

export const BlankName = errorKind(
  'blank_name',
  () => 'A name must contain at least one non-blank character',
  WorkspaceError,
)
export const ProjectNotFound = errorKind(
  'project_not_found',
  (projectId: string) => `Project ${projectId} was not found`,
  WorkspaceError,
)
export const ChatNotFound = errorKind(
  'chat_not_found',
  (chatId: string) => `Chat ${chatId} was not found`,
  WorkspaceError,
)
export const CrossWorkspaceMove = errorKind(
  'cross_workspace_move',
  () => 'A chat can only move to a project of its own workspace',
  WorkspaceError,
)
export const SourceChatArchived = errorKind(
  'source_chat_archived',
  () => 'A runtime chat cannot start from an archived chat',
  WorkspaceError,
)
export const ForeignWorkspace = errorKind(
  'foreign_workspace',
  () => 'The change targets a workspace other than the current one',
  WorkspaceError,
)
export const RuntimeChatPrivate = errorKind(
  'runtime_chat_private',
  () => 'A runtime chat is always private',
  WorkspaceError,
)
