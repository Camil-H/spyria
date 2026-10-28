import type { WorkspacePermission } from '@spyria/kernel'
import type { OnboardingFacts, OnboardingRecords, OnboardingTask } from '../domain/tasks.ts'

export type OnboardingRepository = {
  facts(): Promise<OnboardingFacts>
  records(): Promise<OnboardingRecords>
  permissions(): Promise<readonly WorkspacePermission[]>
  recordCompleted(task: OnboardingTask): Promise<void>
  skip(task: OnboardingTask): Promise<void>
  restore(task: OnboardingTask): Promise<void>
}
