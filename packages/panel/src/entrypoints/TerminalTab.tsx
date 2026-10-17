import { useQuery } from '@hq/db/react'
import { getTerminal } from '../queries/get-terminal.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

const TerminalTab = ({ workspaceId, chatId }: TabProps) => {
  const lines = useQuery(getTerminal(workspaceId, chatId))
  if (lines.length === 0) return <p className={emptyClass}>No terminal output</p>
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-xs">
      {lines.join('\n')}
    </pre>
  )
}

export default TerminalTab
