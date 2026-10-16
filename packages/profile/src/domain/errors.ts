import { DomainError, errorKind } from '@hq/kernel'

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
export const NoGatewayKey = errorKind('no_gateway_key', () => 'Add an LLM key before connecting tools', ProfileError)
