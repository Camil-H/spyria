import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import type { ConnectionTool } from '@spyria/kernel'
import { cardClass, fieldClass, tabTriggerClass } from '@spyria/ui'
import { type ReactNode, useState } from 'react'
import { type ToolKind, toolKindOf, toolKinds } from '../domain/tool-approval.ts'

export type TableTool = ConnectionTool & { summary?: string }
export type ToolColumn<Tool extends TableTool> = {
  key: string
  heading: (shownTools: readonly Tool[], kind: ToolKind) => ReactNode
  cell: (tool: Tool) => ReactNode
}

export const ToolTable = <Tool extends TableTool>({
  serverName,
  tools,
  columns,
  detailOf,
}: {
  serverName: string
  tools: readonly Tool[]
  columns: readonly ToolColumn<Tool>[]
  detailOf?: (tool: Tool) => ReactNode
}) => {
  const [chosenKind, setChosenKind] = useState<ToolKind>('Read')
  const [search, setSearch] = useState('')
  const groups = toolKinds
    .map((kind) => ({ kind, tools: tools.filter((tool) => toolKindOf(tool) === kind) }))
    .filter((group) => group.tools.length > 0)
  const openKind = groups.some(({ kind }) => kind === chosenKind) ? chosenKind : groups[0]?.kind
  const searched = search.trim().toLowerCase()
  if (groups.length === 0) return <p className="text-sm text-muted">This server lists no tools</p>
  return (
    <Root value={openKind} onValueChange={(value) => setChosenKind(value as ToolKind)} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line">
        <List aria-label={`Tool kinds of ${serverName}`} className="flex gap-2">
          {groups.map(({ kind, tools: kindTools }) => (
            <Trigger key={kind} value={kind} className={`${tabTriggerClass} px-3`}>
              {kind} <span className="text-xs text-muted">{kindTools.length}</span>
            </Trigger>
          ))}
        </List>
        <input
          type="search"
          aria-label={`Search tools of ${serverName}`}
          placeholder="Search tools"
          className={`${fieldClass} mb-1.5 w-48`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {groups.map(({ kind, tools: kindTools }) => {
        const shownTools = kindTools.filter((tool) => tool.name.toLowerCase().includes(searched))
        return (
          <Content key={kind} value={kind} className={`${cardClass} overflow-x-auto`}>
            <table aria-label={`${kind} tools of ${serverName}`} className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-muted">
                    Tool
                  </th>
                  {columns.map((column) => (
                    <th key={column.key} scope="col" className="min-w-28 px-3 py-2 text-center font-medium">
                      {column.heading(shownTools, kind)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shownTools.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="px-4 py-3 text-muted">
                      No tool matches
                    </td>
                  </tr>
                )}
                {shownTools.map((tool) => (
                  <tr key={tool.name} className="hover:bg-hover">
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      <span className="flex flex-col">
                        <span className="font-mono text-xs">{tool.name}</span>
                        {tool.summary && <span className="text-xs text-muted">{tool.summary}</span>}
                        {detailOf?.(tool)}
                      </span>
                    </th>
                    {columns.map((column) => (
                      <td key={column.key} className="px-3 py-2 text-center">
                        {column.cell(tool)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Content>
        )
      })}
    </Root>
  )
}
