import { useQuery } from '@hq/db/react'
import { focusRing } from '@hq/ui'
import { useState } from 'react'
import { getChanges } from '../queries/get-changes.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

const lineStyles = {
  added: { marker: '+', className: 'bg-added' },
  removed: { marker: '-', className: 'bg-removed' },
  context: { marker: ' ', className: '' },
}

export const ChangesTab = ({ workspaceId, chatId }: TabProps) => {
  const changes = useQuery(getChanges(workspaceId, chatId))
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  if (changes.length === 0) return <p className={emptyClass}>No changes</p>
  const selectedChange = changes.find((change) => change.path === selectedPath)
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1 text-sm">
        {changes.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              aria-pressed={change.path === selectedPath}
              onClick={() => setSelectedPath(change.path)}
              className={`flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md px-2 py-1 text-left hover:bg-hover aria-pressed:bg-selected ${focusRing}`}
            >
              <span className="break-all">{change.path}</span>
              <span className="font-mono text-xs text-muted">
                +{change.additions} −{change.deletions}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selectedChange && (
        <section aria-label="Diff" className="overflow-x-auto rounded-md border border-line font-mono text-xs">
          {[...selectedChange.diffLines.entries()].map(([lineNumber, line]) => (
            <div key={lineNumber} className={`whitespace-pre px-2 py-0.5 ${lineStyles[line.kind].className}`}>
              {lineStyles[line.kind].marker} {line.text}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
