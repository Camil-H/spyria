import { createCommandsContext } from '@spyria/ui'
import type { OnboardingCommands } from './commands.ts'

export const [OnboardingProvider, useOnboardingCommands] =
  createCommandsContext<OnboardingCommands>('OnboardingProvider')
