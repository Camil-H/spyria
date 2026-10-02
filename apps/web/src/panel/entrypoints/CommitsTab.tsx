import { useQuery } from '@hq/db'
import { getCommits } from '../queries/get-commits.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

export const CommitsTab = ({ workspaceId, chatId }: TabProps) => {
  const commits = useQuery(getCommits(workspaceId, chatId))
  if (commits.length === 0) return <p className={emptyClass}>No commits</p>
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {commits.map((commit) => (
        <li key={commit.sha} className="flex flex-col gap-0.5">
          <span>
            <span className="font-mono text-xs text-muted">{commit.sha}</span> {commit.message}
          </span>
          <span className="text-xs text-muted">
            {commit.authorName} · {commit.committedAt.slice(11, 16)} UTC
          </span>
        </li>
      ))}
    </ul>
  )
}
