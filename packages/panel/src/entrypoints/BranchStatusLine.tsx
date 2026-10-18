import { type BranchStatus, branchStatusPartsOf } from '../domain/workspace.ts'

const pushTimeOf = (pushedAt: string) =>
  new Date(pushedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

export const BranchStatusLine = ({
  workingBranch,
  baseBranch,
  status,
}: {
  workingBranch: string
  baseBranch: string
  status: BranchStatus
}) => (
  <section aria-label="Branch status" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
    <span className="font-mono font-medium text-ink">
      {workingBranch} → {baseBranch}
    </span>
    {branchStatusPartsOf(status, baseBranch).map((part) => (
      <span key={part}>{part}</span>
    ))}
    {status.pushedAt && <span>Last push {pushTimeOf(status.pushedAt)}</span>}
  </section>
)
