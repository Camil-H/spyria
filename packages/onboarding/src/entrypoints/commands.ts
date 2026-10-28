import type { WorkspaceId } from '@spyria/kernel'
import type { OnboardingTask } from '../domain/tasks.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<unknown>

export type OnboardingCommands = {
  recordCompletedTasks: Command<object>
  skipTask: Command<{ task: OnboardingTask }>
  restoreTask: Command<{ task: OnboardingTask }>
}
