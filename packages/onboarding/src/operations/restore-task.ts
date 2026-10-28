import type { OnboardingTransactor } from '../contracts/transactor.ts'
import type { OnboardingTask } from '../domain/tasks.ts'

type Dependencies = { transactor: OnboardingTransactor }

export const restoreTask = ({ transactor }: Dependencies, { task }: { task: OnboardingTask }) =>
  transactor.run(({ onboarding }) => onboarding.restore(task))
