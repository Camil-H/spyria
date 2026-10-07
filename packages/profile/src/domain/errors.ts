export class ProfileError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class BlankDisplayName extends ProfileError {
  constructor() {
    super('blank_display_name', 'A display name must contain at least one non-blank character')
  }
}

export class BlankProvider extends ProfileError {
  constructor() {
    super('blank_provider', 'A provider must contain at least one non-blank character')
  }
}

export class UnsupportedProvider extends ProfileError {
  constructor(provider: string) {
    super('unsupported_provider', `${provider} is not a supported provider`)
  }
}

export class BlankSecret extends ProfileError {
  constructor() {
    super('blank_secret', 'A secret must contain at least one non-blank character')
  }
}

export class CredentialNotFound extends ProfileError {
  constructor(credentialId: string) {
    super('credential_not_found', `LLM credential ${credentialId} was not found`)
  }
}

export class NotOwnProfile extends ProfileError {
  constructor() {
    super('not_own_profile', 'A member can only change their own profile in their current workspace')
  }
}

export class MemberNotFound extends ProfileError {
  constructor(memberId: string) {
    super('member_not_found', `Member ${memberId} was not found`)
  }
}

export class ToolNotInCatalog extends ProfileError {
  constructor(tool: string) {
    super('tool_not_in_catalog', `Tool ${tool} is not in the catalog`)
  }
}

export class NoGatewayKey extends ProfileError {
  constructor() {
    super('no_gateway_key', 'Add an LLM key before connecting tools')
  }
}
