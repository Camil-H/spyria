export class RuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class HostRefused extends RuntimeError {}

const errorKind = <Details extends unknown[]>(
  code: string,
  messageOf: (...details: Details) => string,
  Base: typeof RuntimeError = RuntimeError,
) =>
  class extends Base {
    constructor(...details: Details) {
      super(code, messageOf(...details))
    }
  }

export const NotWorkspaceAdmin = errorKind('not_admin', () => 'Only workspace admins can manage runtime hosts')
export const MachineAlreadyAdded = errorKind(
  'machine_already_added',
  () => 'Your machine is already added: remove it first',
)
export const NotCurrentWorkspace = errorKind(
  'not_current_workspace',
  () => 'A runtime host can only be managed in the current workspace',
)
export const BlankHostName = errorKind(
  'blank_host_name',
  () => 'A host name must contain at least one non-blank character',
)
export const HostNameTooLong = errorKind('host_name_too_long', () => 'A host name has at most 60 characters')
export const HostNotFound = errorKind('host_not_found', (hostId: string) => `Runtime host ${hostId} was not found`)
export const CodeNotRenewable = errorKind(
  'code_not_renewable',
  () => 'Only a host still waiting for its first connection gets a new command',
)
export const CodeNotValid = errorKind('code_not_valid', () => 'This code is not valid', HostRefused)
export const CodeAlreadyUsed = errorKind('code_already_used', () => 'This code was already used', HostRefused)
export const CodeExpired = errorKind('code_expired', () => 'This code has expired', HostRefused)
export const HostRemoved = errorKind('host_removed', () => 'This host was removed', HostRefused)
export const HostNotRegistered = errorKind('host_not_registered', () => 'This host is not registered', HostRefused)
export const PairedAsMachine = errorKind(
  'paired_as_machine',
  () => 'This host was paired as your machine: restart hq-host with --personal',
  HostRefused,
)
export const PairedAsWorkspaceHost = errorKind(
  'paired_as_workspace_host',
  () => 'This host was paired as a workspace host: restart hq-host without --personal',
  HostRefused,
)
export const RuntimeNotFound = errorKind(
  'runtime_not_found',
  (runtimeId: string) => `Runtime ${runtimeId} was not found`,
)
export const TransitionRefused = errorKind(
  'transition_refused',
  (from: string, to: string) => `A runtime cannot go from ${from} to ${to}`,
)
export const RuntimeNotReady = errorKind(
  'runtime_not_ready',
  (runtimeId: string) => `Runtime ${runtimeId} was not ready in time`,
)
export const ApiKeyMissing = errorKind('api_key_missing', (runtimeId: string) => `Runtime ${runtimeId} has no API key`)
export const RetryRefused = errorKind('retry_refused', () => 'Only a runtime that could not start can be retried')
