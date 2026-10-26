import { DomainError, errorKind } from '@spyria/kernel'

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
export const OwnMembership = errorKind(
  'own_membership',
  () => 'You can neither change your own role nor remove yourself',
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
export const DomainFixed = errorKind(
  'domain_fixed',
  (domain: string) =>
    `The email domain of this workspace is ${domain}: it is set when the workspace is created and cannot be changed`,
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
    'Email is not configured on this server (SPYRIA_SMTP_URL): the operator can verify the domain with sso:verify-domain',
  WorkspaceError,
)
export const MailNotSent = errorKind(
  'mail_not_sent',
  (reason: string) => `The verification email could not be sent: ${reason}`,
  WorkspaceError,
)
export const WorkspaceCreationClosed = errorKind(
  'workspace_creation_closed',
  () => 'Workspace creation is closed on this instance: sign in with your work email',
  WorkspaceError,
)
export const DomainNotVerified = errorKind(
  'domain_not_verified',
  () =>
    'Invites open once an email domain of this workspace is verified: send the verification link from the Sign-in settings',
  WorkspaceError,
)
export const InvalidGitHubSettings = errorKind('invalid_github_settings', (reason: string) => reason, WorkspaceError)
export const GitHubNotConfigured = errorKind(
  'github_not_configured',
  () => 'No GitHub App is configured for this workspace',
  WorkspaceError,
)
export const GitHubRefused = errorKind(
  'github_refused',
  (reason: string) => `GitHub refused: ${reason}`,
  WorkspaceError,
)
export const GitHubUnreachable = errorKind(
  'github_unreachable',
  (reason: string) => `GitHub could not be reached: ${reason}`,
  WorkspaceError,
)
export const GitHubPermissionMissing = errorKind(
  'github_permission_missing',
  (permission: string) => `Ask a GitHub admin to accept the ${permission} permission for this workspace's GitHub App`,
  WorkspaceError,
)
export const RepositoryNotGranted = errorKind(
  'repository_not_granted',
  (repository: string) => `${repository} is not granted to the workspace's GitHub App`,
  WorkspaceError,
)
export const BranchNotFound = errorKind(
  'branch_not_found',
  (repository: string, branch: string) => `${repository} has no branch ${branch}`,
  WorkspaceError,
)
export const InvalidRoleName = errorKind(
  'invalid_role_name',
  () => 'A role name has 1 to 40 characters',
  WorkspaceError,
)
export const ReservedRoleName = errorKind(
  'reserved_role_name',
  (name: string) => `${name} is the name of a built-in role`,
  WorkspaceError,
)
export const RoleNameTaken = errorKind(
  'role_name_taken',
  (name: string) => `A role named ${name} already exists`,
  WorkspaceError,
)
export const UnknownChatPermission = errorKind(
  'unknown_chat_permission',
  (permission: string) => `${permission} is not a chat permission`,
  WorkspaceError,
)
export const CustomRoleNotFound = errorKind(
  'custom_role_not_found',
  (roleId: string) => `${roleId} is not a custom role of this workspace`,
  WorkspaceError,
)
export const RoleInUse = errorKind(
  'role_in_use',
  (name: string, holders: string) => `${name} is held by ${holders}; change their role first`,
  WorkspaceError,
)
export const UnknownWorkspacePermission = errorKind(
  'unknown_workspace_permission',
  (permission: string) => `${permission} is not a workspace permission`,
  WorkspaceError,
)
export const WorkspaceRoleNotFound = errorKind(
  'workspace_role_not_found',
  (roleId: string) => `${roleId} is not a role of this workspace`,
  WorkspaceError,
)
export const RoleNotGrantable = errorKind(
  'role_not_grantable',
  (name: string) => `${name} has permissions your own role does not have`,
  WorkspaceError,
)
export const AdminOnly = errorKind('admin_only', () => 'Only an Admin can delete this workspace', WorkspaceError)
