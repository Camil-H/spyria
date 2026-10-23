import { DomainError, errorKind } from '@spyria/kernel'

export class RuntimeError extends DomainError {}

export class HostRefused extends RuntimeError {}

export const MachineAlreadyAdded = errorKind(
  'machine_already_added',
  () => 'Your machine is already added: remove it first',
  RuntimeError,
)
export const LocalSessionsOff = errorKind(
  'local_sessions_off',
  () => "Your workspace turned off sessions on members' machines",
  RuntimeError,
)
export const NotCurrentWorkspace = errorKind(
  'not_current_workspace',
  () => 'A runtime host can only be managed in the current workspace',
  RuntimeError,
)
export const BlankHostName = errorKind(
  'blank_host_name',
  () => 'A host name must contain at least one non-blank character',
  RuntimeError,
)
export const HostNameTooLong = errorKind(
  'host_name_too_long',
  () => 'A host name has at most 60 characters',
  RuntimeError,
)
export const HostNotFound = errorKind(
  'host_not_found',
  (hostId: string) => `Runtime host ${hostId} was not found`,
  RuntimeError,
)
export const CodeNotRenewable = errorKind(
  'code_not_renewable',
  () => 'Only a host still waiting for its first connection gets a new command',
  RuntimeError,
)
export const CodeNotValid = errorKind('code_not_valid', () => 'This code is not valid', HostRefused)
export const CodeAlreadyUsed = errorKind('code_already_used', () => 'This code was already used', HostRefused)
export const CodeExpired = errorKind('code_expired', () => 'This code has expired', HostRefused)
export const HostRemoved = errorKind('host_removed', () => 'This host was removed', HostRefused)
export const HostNotRegistered = errorKind('host_not_registered', () => 'This host is not registered', HostRefused)
export const PairedAsMachine = errorKind(
  'paired_as_machine',
  () => 'This host was paired as your machine: restart spyria-host with --personal',
  HostRefused,
)
export const PairedAsWorkspaceHost = errorKind(
  'paired_as_workspace_host',
  () => 'This host was paired as a workspace host: restart spyria-host without --personal',
  HostRefused,
)
export const RuntimeNotFound = errorKind(
  'runtime_not_found',
  (runtimeId: string) => `Runtime ${runtimeId} was not found`,
  RuntimeError,
)
export const TransitionRefused = errorKind(
  'transition_refused',
  (from: string, to: string) => `A runtime cannot go from ${from} to ${to}`,
  RuntimeError,
)
export const RuntimeNotReady = errorKind(
  'runtime_not_ready',
  (runtimeId: string) => `Runtime ${runtimeId} was not ready in time`,
  RuntimeError,
)
export const RetryRefused = errorKind(
  'retry_refused',
  () => 'Only a runtime that could not start can be retried',
  RuntimeError,
)
