import { DomainError, errorKind } from '@spyria/kernel'

export class OnboardingError extends DomainError {}

export const NotOwnOnboarding = errorKind(
  'not_own_onboarding',
  () => 'A member can only change their own checklist in their current workspace',
  OnboardingError,
)
