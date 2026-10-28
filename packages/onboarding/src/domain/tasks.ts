import type { WorkspacePermission } from '@spyria/kernel'

export const onboardingTasks = [
  'verify-domain',
  'connect-github-app',
  'connect-runtime',
  'add-ai-key',
  'invite-members',
  'link-github-account',
  'add-profile-picture',
] as const

export type OnboardingTask = (typeof onboardingTasks)[number]
export type TaskScope = 'workspace' | 'member'
export type TaskState = 'done' | 'skipped' | 'blocked' | 'open'
export type TaskView = Readonly<{ task: OnboardingTask; scope: TaskScope; state: TaskState }>

export type OnboardingFacts = Readonly<{
  isDomainVerified: boolean
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

export type Viewer = Readonly<{ permissions: readonly WorkspacePermission[]; usesSingleSignOn: boolean }>

const permissionByWorkspaceTask: Partial<Record<OnboardingTask, WorkspacePermission>> = {
  'verify-domain': 'sso.manage',
  'connect-github-app': 'github.manage',
  'connect-runtime': 'runtimes.manage',
  'invite-members': 'members.invite',
}

const factByTask: Record<OnboardingTask, keyof OnboardingFacts> = {
  'verify-domain': 'isDomainVerified',
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
    if (task === 'verify-domain') return viewer.usesSingleSignOn
    if (task === 'link-github-account') return isDone('connect-github-app')
    return true
  }
  const isBlocked = (task: OnboardingTask) =>
    task === 'invite-members' && viewer.usesSingleSignOn && !isDone('verify-domain')
  const stateOf = (task: OnboardingTask): TaskState => {
    if (isDone(task)) return 'done'
    if (records.skipped.has(task)) return 'skipped'
    return isBlocked(task) ? 'blocked' : 'open'
  }
  return onboardingTasks.filter(isShown).map((task) => ({ task, scope: scopeOf(task), state: stateOf(task) }))
}

export const isSettled = (view: TaskView) => view.state === 'done' || view.state === 'skipped'

export const nextTaskOf = (views: readonly TaskView[]) => views.find((view) => view.state === 'open')?.task
