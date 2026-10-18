import { DomainError, errorKind } from '@hq/kernel'

class WorkspaceError extends DomainError {}

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
export const NotWorkspaceAdmin = errorKind(
  'not_admin',
  () => 'Only a workspace admin can manage members',
  WorkspaceError,
)
export const InvalidEmail = errorKind('invalid_email', (email: string) => `${email} is not an email`, WorkspaceError)
export const AlreadyMember = errorKind(
  'already_member',
  (email: string) => `${email} is already a member of this workspace`,
  WorkspaceError,
)
export const InviteAlreadyPending = errorKind(
  'invite_already_pending',
  (email: string) => `${email} already has a pending invite`,
  WorkspaceError,
)
export const InviteNotFound = errorKind(
  'invite_not_found',
  (invitationId: string) => `Invite ${invitationId} is not pending`,
  WorkspaceError,
)
export const MemberNotFound = errorKind(
  'member_not_found',
  (memberId: string) => `${memberId} is not a member of this workspace`,
  WorkspaceError,
)
export const LastAdmin = errorKind(
  'last_admin',
  () => 'The last admin of a workspace can be neither demoted nor removed',
  WorkspaceError,
)
export const ChatOwnerActive = errorKind(
  'chat_owner_active',
  () => 'Only a chat whose owner left the workspace can be transferred',
  WorkspaceError,
)
export const InvalidSsoSettings = errorKind('invalid_sso_settings', (reason: string) => reason, WorkspaceError)
export const DomainClaimed = errorKind(
  'domain_claimed',
  (domain: string) => `${domain} already signs in through another provider`,
  WorkspaceError,
)
export const SsoDiscoveryFailed = errorKind(
  'sso_discovery_failed',
  (issuer: string, reason: string) => `The discovery of ${issuer} failed: ${reason}`,
  WorkspaceError,
)
export const MailNotConfigured = errorKind(
  'mail_not_configured',
  () =>
    'Email is not configured on this server (HQ_SMTP_URL): the operator can verify the domain with sso:verify-domain',
  WorkspaceError,
)
export const MailNotSent = errorKind(
  'mail_not_sent',
  (reason: string) => `The verification email could not be sent: ${reason}`,
  WorkspaceError,
)
