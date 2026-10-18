export const gitActions = ['commit', 'update'] as const
export type GitAction = (typeof gitActions)[number]
export type GitActionOutcome = { isRefused: boolean; text: string; conflicts?: string[] }

export const isGitAction = (action: string): action is GitAction => gitActions.some((known) => known === action)
export const gitActionRefusalOf = (ownerName: string) =>
  `Only ${ownerName} can commit or update the branch in this chat`
export const turnRunningRefusal = 'The agent is working: wait for its turn to end'
export const asleepRefusal = 'The runtime is asleep: wake it first'
export const noReplyAuthorOf = (name: string, memberId: string) => ({ name, email: `${memberId}@users.noreply.hq` })
export const conflictTextOf = (baseBranch: string, conflicts: readonly string[]) =>
  `Updating from ${baseBranch} conflicts in ${conflicts.join(', ')}; the merge was aborted`
