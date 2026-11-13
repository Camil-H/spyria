import { blankKind, DomainError, errorKind } from '@spyria/kernel'

class WorkspaceError extends DomainError {}

export const BlankName = blankKind('blank_name', 'A name', WorkspaceError)
export const ProjectNotFound = errorKind(
  'project_not_found',
  (projectId: string) => `Project ${projectId} was not found`,
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
export const EmailNotConfirmed = errorKind(
  'email_not_confirmed',
  () => 'Your provider did not confirm this address',
  WorkspaceError,
)
export const SsoDiscoveryFailed = errorKind(
  'sso_discovery_failed',
  (issuer: string) =>
    `The discovery of ${issuer} failed: check that the issuer is right and reachable from this Spyria`,
  WorkspaceError,
)
export const WorkspaceCreationClosed = errorKind(
  'workspace_creation_closed',
  () => 'This Spyria already has a workspace: sign in, then create yours',
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
export const InvalidDevLoopSettings = errorKind(
  'invalid_dev_loop_settings',
  () =>
    'Each command gate needs a name of its own, a command and a timeout of 1 to 120 minutes; fixes go from 0 to 10; a repository has at most 20 gates, one code review, one pull request and one CI gate, and only CI may follow the pull request; the time limit goes from 10 minutes to 24 hours and a cost limit is above 0',
  WorkspaceError,
)
export const InvalidSetupCommands = errorKind(
  'invalid_setup_commands',
  () => 'Each setup command needs a command of at most 2,000 characters, with one command per repository',
  WorkspaceError,
)
export const AccountSignInRequired = errorKind(
  'account_sign_in_required',
  () => "Your organization's sign-in opens only its workspace: sign in with your own account to do this",
  WorkspaceError,
)
export const ClaimedDomainCannotCreate = errorKind(
  'claimed_domain_cannot_create',
  () => "Your address belongs to your organization's workspace: it cannot create another one",
  WorkspaceError,
)
export const ClaimedDomainNotInvited = errorKind(
  'claimed_domain_not_invited',
  (domain: string) =>
    `${domain} belongs to your organization's workspace, which has not invited you: ask one of its Admins for an invite. Addresses at ${domain} cannot create a workspace of their own.`,
  WorkspaceError,
)
export const InvalidDomain = errorKind(
  'invalid_domain',
  (domain: string) => `${domain} is not a domain name, such as example.com`,
  WorkspaceError,
)
export const DomainClaimedElsewhere = errorKind(
  'domain_claimed_elsewhere',
  (domain: string) => `${domain} belongs to another workspace of this Spyria: its addresses can join only that one`,
  WorkspaceError,
)
export const OutsideClaimedDomains = errorKind(
  'outside_claimed_domains',
  (email: string) => `This workspace signs in only addresses at its own domains, and ${email} is not one of them`,
  WorkspaceError,
)
export const ClaimWouldLockYouOut = errorKind(
  'claim_would_lock_you_out',
  (domain: string) =>
    `Your own address is at ${domain}, which would be outside this workspace's domains: you could no longer sign in`,
  WorkspaceError,
)
export const ClaimNeedsSso = errorKind(
  'claim_needs_sso',
  () => 'Enforce SSO first: a claimed domain signs in through your provider',
  WorkspaceError,
)
export const DomainClaimNotFound = errorKind(
  'domain_claim_not_found',
  (domain: string) => `${domain} is not claimed by this workspace`,
  WorkspaceError,
)
export const VerificationRecordNotFound = errorKind(
  'verification_record_not_found',
  (domain: string) =>
    `The TXT record was not found at ${domain} yet: DNS changes can take a few minutes, sometimes hours. Try again later`,
  WorkspaceError,
)
export const SignInThroughClaimingProvider = errorKind(
  'sign_in_through_claiming_provider',
  (email: string) => `${email} signs in through your organization's provider: enter your address to sign in`,
  WorkspaceError,
)
export const NoAccountSignIn = errorKind(
  'no_account_sign_in',
  () =>
    'This Spyria has no sign-in of its own for members to use instead: an operator sets up Google, Microsoft or OIDC',
  WorkspaceError,
)
export const SsoAddressMismatch = errorKind(
  'sso_address_mismatch',
  (email: string) => `Sign in as ${email} to confirm the provider: nothing was changed`,
  WorkspaceError,
)
export const AccountBoundElsewhere = errorKind(
  'account_bound_elsewhere',
  (email: string) => `${email} already signs in with another account: sign in with that one`,
  WorkspaceError,
)
export const InstanceBeingSetUp = errorKind(
  'instance_being_set_up',
  () => 'This Spyria is being set up: open the setup link to create its first workspace',
  WorkspaceError,
)
