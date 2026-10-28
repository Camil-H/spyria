import { GitCommitHorizontal } from 'lucide-react'
import { commitsOf } from '../domain/workspace.ts'
import { EmptyState } from './EmptyState.tsx'
import type { TabProps } from './TabProps.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

const CommitsTab = ({ workspaceId, chatId }: TabProps) => {
  const { reading } = useWorkspaceReading(workspaceId, chatId, 'changes')
  const commits = commitsOf(reading?.log)
  return (
    <>
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {reading && commits.length === 0 && (
        <EmptyState Icon={GitCommitHorizontal} title="No commits" hint="Commits on the working branch show here." />
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {commits.map((commit) => (
          <li key={commit.sha} className="flex flex-col gap-0.5">
            <span className="font-mono text-xs text-muted">{commit.sha}</span>
            <span className="font-semibold break-words">{commit.subject}</span>
            <span className="text-xs text-muted">
              {commit.author} · {commit.committedAt.slice(11, 16)} UTC
            </span>
            {commit.body && <p className="mt-1 whitespace-pre-wrap break-words text-xs">{commit.body}</p>}
          </li>
        ))}
      </ul>
    </>
  )
}

export default CommitsTab
