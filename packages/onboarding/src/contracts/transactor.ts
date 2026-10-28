import type { Transactor } from '@spyria/kernel'
import type { OnboardingRepository } from './repositories.ts'

export type UnitOfWork = { onboarding: OnboardingRepository }

export type OnboardingTransactor = Transactor<UnitOfWork>
