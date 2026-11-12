import type { ConnectionTool } from '@spyria/kernel'
import { fieldClass } from '@spyria/ui'
import { type ReactNode, useState } from 'react'

const groups = [
  { title: 'Read tools', isReadOnly: true },
  { title: 'Write tools', isReadOnly: false },
] as const

export const toolCountsOf = (tools: readonly ConnectionTool[]) => {
  const readCount = tools.filter((tool) => tool.readOnly).length
  return `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} · ${readCount} read · ${tools.length - readCount} write`
}

type ListedTool = ConnectionTool & { summary?: string }

export const ToolList = ({
  label,
  tools,
  controlOf,
  groupControlOf,
}: {
  label: string
  tools: readonly ListedTool[]
  controlOf: (tool: ConnectionTool) => ReactNode
  groupControlOf?: (title: string, groupTools: readonly ConnectionTool[]) => ReactNode
}) => {
  const [search, setSearch] = useState('')
  const searched = search.trim().toLowerCase()
  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        aria-label={`Search ${label}`}
        placeholder="Search tools"
        className={fieldClass}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {groups.map(({ title, isReadOnly }) => {
        const groupTools = tools.filter((tool) => tool.readOnly === isReadOnly)
        const shown = groupTools.filter((tool) => tool.name.toLowerCase().includes(searched))
        if (groupTools.length === 0) return null
        return (
          <section key={title} aria-label={`${title} of ${label}`} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase text-muted">
                {title} ({groupTools.length})
              </h4>
              {groupControlOf?.(title, groupTools)}
            </div>
            {shown.length === 0 ? (
              <p className="text-xs text-muted">No tool matches</p>
            ) : (
              <ul className="flex flex-col">
                {shown.map((tool) => (
                  <li key={tool.name} className="flex items-center justify-between gap-3 py-0.5">
                    <span className="flex flex-col">
                      <span>
                        {tool.name}
                        {tool.destructive && <span className="ml-2 text-xs text-muted">destructive</span>}
                      </span>
                      {tool.summary && <span className="text-xs text-muted">{tool.summary}</span>}
                    </span>
                    {controlOf(tool)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
