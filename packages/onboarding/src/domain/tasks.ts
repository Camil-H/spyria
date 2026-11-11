import type { WorkspacePermission } from '@spyria/kernel'

export const onboardingTasks = [
  'connect-github-app',
  'connect-runtime',
  'add-ai-key',
  'invite-members',
  'link-github-account',
  'add-profile-picture',
] as const

export type OnboardingTask = (typeof onboardingTasks)[number]
export type TaskScope = 'workspace' | 'member'
export type TaskState = 'done' | 'open'
export type TaskView = Readonly<{ task: OnboardingTask; scope: TaskScope; state: TaskState }>

export type OnboardingFacts = Readonly<{
  hasGitHubApp: boolean
  hasClaimedRuntimeHost: boolean
  hasInvitedSomeone: boolean
  hasAiKey: boolean
  hasGitHubAccount: boolean
  hasProfilePicture: boolean
}>

export type OnboardingRecords = Readonly<{
  completed: ReadonlySet<OnboardingTask>
  skipped: ReadonlySet<OnboardingTask>
}>

export type Viewer = Readonly<{ permissions: readonly WorkspacePermission[] }>

const permissionByWorkspaceTask: Partial<Record<OnboardingTask, WorkspacePermission>> = {
  'connect-github-app': 'github.manage',
  'connect-runtime': 'runtimes.manage',
  'invite-members': 'members.invite',
}

const factByTask: Record<OnboardingTask, keyof OnboardingFacts> = {
  'connect-github-app': 'hasGitHubApp',
  'connect-runtime': 'hasClaimedRuntimeHost',
  'add-ai-key': 'hasAiKey',
  'invite-members': 'hasInvitedSomeone',
  'link-github-account': 'hasGitHubAccount',
  'add-profile-picture': 'hasProfilePicture',
}

export const isOnboardingTask = (value: string): value is OnboardingTask => onboardingTasks.includes(value as never)

export const scopeOf = (task: OnboardingTask): TaskScope =>
  permissionByWorkspaceTask[task] === undefined ? 'member' : 'workspace'

const mayDo = (task: OnboardingTask, permissions: readonly WorkspacePermission[]) => {
  const permission = permissionByWorkspaceTask[task]
  return permission === undefined || permissions.includes(permission)
}

export const tasksToRecordOf = (
  facts: OnboardingFacts,
  records: OnboardingRecords,
  permissions: readonly WorkspacePermission[],
) =>
  onboardingTasks.filter((task) => facts[factByTask[task]] && !records.completed.has(task) && mayDo(task, permissions))

export const taskViewsOf = (facts: OnboardingFacts, records: OnboardingRecords, viewer: Viewer): TaskView[] => {
  const isDone = (task: OnboardingTask) => records.completed.has(task) || facts[factByTask[task]]
  const isShown = (task: OnboardingTask) => {
    if (!mayDo(task, viewer.permissions)) return false
    if (records.skipped.has(task)) return false
    if (task === 'link-github-account') return isDone('connect-github-app')
    return true
  }
  const stateOf = (task: OnboardingTask): TaskState => (isDone(task) ? 'done' : 'open')
  return onboardingTasks.filter(isShown).map((task) => ({ task, scope: scopeOf(task), state: stateOf(task) }))
}

export const isDoneView = (view: TaskView) => view.state === 'done'

export const nextTaskOf = (views: readonly TaskView[]) => views.find((view) => view.state === 'open')?.task
