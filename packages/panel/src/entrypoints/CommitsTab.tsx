import { commitsOf } from '../domain/workspace.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const CommitsTab = ({ workspaceId, chatId }: TabProps) => {
  const { reading } = useWorkspaceReading(workspaceId, chatId, 'changes')
  const commits = commitsOf(reading?.log)
  return (
    <>
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {reading && commits.length === 0 && <p className={emptyClass}>No commits</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {commits.map((commit) => (
          <li key={commit.sha} className="flex flex-col gap-0.5">
            <span>
              <span className="font-mono text-xs text-muted">{commit.sha}</span> {commit.subject}
            </span>
            <span className="text-xs text-muted">
              {commit.author} · {commit.committedAt.slice(11, 16)} UTC
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

export default CommitsTab
