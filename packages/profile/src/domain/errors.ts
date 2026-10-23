import { DomainError, errorKind } from '@spyria/kernel'

export class ProfileError extends DomainError {}

export const BlankDisplayName = errorKind(
  'blank_display_name',
  () => 'A display name must contain at least one non-blank character',
  ProfileError,
)
export const BlankProvider = errorKind(
  'blank_provider',
  () => 'A provider must contain at least one non-blank character',
  ProfileError,
)
export const UnsupportedProvider = errorKind(
  'unsupported_provider',
  (provider: string) => `${provider} is not a supported provider`,
  ProfileError,
)
export const BlankSecret = errorKind(
  'blank_secret',
  () => 'A secret must contain at least one non-blank character',
  ProfileError,
)
export const CredentialNotFound = errorKind(
  'credential_not_found',
  (credentialId: string) => `LLM credential ${credentialId} was not found`,
  ProfileError,
)
export const NotOwnProfile = errorKind(
  'not_own_profile',
  () => 'A member can only change their own profile in their current workspace',
  ProfileError,
)
export const MemberNotFound = errorKind(
  'member_not_found',
  (memberId: string) => `Member ${memberId} was not found`,
  ProfileError,
)
export const ToolNotInCatalog = errorKind(
  'tool_not_in_catalog',
  (tool: string) => `Tool ${tool} is not in the catalog`,
  ProfileError,
)
export const ToolStillConnected = errorKind(
  'tool_still_connected',
  (tool: string) => `${tool} is still connected: disconnect it, then connect again`,
  ProfileError,
)
export const NoGatewayKey = errorKind('no_gateway_key', () => 'Add an LLM key before connecting tools', ProfileError)
export const InvalidConnection = errorKind('invalid_connection', (reason: string) => reason, ProfileError)
export const ConnectionNotFound = errorKind(
  'connection_not_found',
  (connectionId: string) => `Workspace connection ${connectionId} was not found`,
  ProfileError,
)
export const ConnectionUnreachable = errorKind(
  'connection_unreachable',
  (url: string) => `No tools could be listed from ${url}`,
  ProfileError,
)
export const SecretRequired = errorKind(
  'secret_required',
  (header: string) => `Enter the ${header} header again to change the URL`,
  ProfileError,
)
