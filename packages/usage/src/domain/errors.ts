import { DomainError, errorKind } from '@hq/kernel'

export class UsageError extends DomainError {}

export const NotWorkspaceAdmin = errorKind(
  'not_admin',
  (action = 'see the audit log') => `Only workspace admins can ${action}`,
  UsageError,
)
export const InvalidSpendFilter = errorKind('invalid_spend_filter', () => 'The spend filter is not valid', UsageError)
export const InvalidAuditFilter = errorKind(
  'invalid_audit_filter',
  () => 'The audit log filter is not valid',
  UsageError,
)
export const InvalidRetention = errorKind(
  'invalid_retention',
  () => 'Keep audit records forever or for 1 to 36500 days',
  UsageError,
)
