import { DomainError, errorKind } from '@spyria/kernel'

export class UsageError extends DomainError {}

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
export const InvalidBudget = errorKind(
  'invalid_budget',
  () => 'A monthly budget is an amount above $0 and up to $1,000,000',
  UsageError,
)
export const BudgetMemberNotFound = errorKind(
  'budget_member_not_found',
  () => 'Budgets are set for active members of the workspace',
  UsageError,
)
