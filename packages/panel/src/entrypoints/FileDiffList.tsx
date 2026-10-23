import { focusRing } from '@spyria/ui'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import {
  type DiffLayout,
  type DiffLine,
  diffLayoutFor,
  type FileChange,
  isCollapsedByDefault,
  splitRowsOf,
} from '../domain/workspace.ts'
import { usePanel } from './providers.tsx'

const markers: Record<DiffLine['kind'], string> = { added: '+', removed: '-', context: ' ', hunk: '' }
const lineClasses: Record<DiffLine['kind'], string> = {
  added: 'bg-added',
  removed: 'bg-removed',
  context: '',
  hunk: 'bg-hover text-muted',
}
const numberClass = 'w-10 select-none px-1 text-right align-top text-muted tabular-nums'
const textClass = 'whitespace-pre-wrap break-all px-2 align-top'

const lineKeyOf = (line: DiffLine | null) =>
  line ? `${line.kind}:${line.oldNumber}:${line.newNumber}:${line.kind === 'hunk' ? line.text : ''}` : 'none'

const LineCells = ({ line, number }: { line: DiffLine | null; number: number | null | undefined }) => (
  <>
    <td className={`${numberClass} ${line ? lineClasses[line.kind] : ''}`}>{number ?? ''}</td>
    <td className={`${textClass} ${line ? lineClasses[line.kind] : ''}`}>
      {line && `${markers[line.kind]} ${line.text}`}
    </td>
  </>
)

const DiffTable = ({ change, layout }: { change: FileChange; layout: DiffLayout }) => (
  <table aria-label={`Diff of ${change.path}`} className="w-full table-fixed border-t border-line font-mono text-xs">
    <tbody>
      {layout === 'unified'
        ? change.lines.map((line) => (
            <tr key={lineKeyOf(line)}>
              <td className={`${numberClass} ${lineClasses[line.kind]}`}>{line.oldNumber ?? ''}</td>
              <LineCells line={line} number={line.newNumber} />
            </tr>
          ))
        : splitRowsOf(change.lines).map(({ left, right }) => (
            <tr key={`${lineKeyOf(left)}|${lineKeyOf(right)}`}>
              {left?.kind === 'hunk' ? (
                <td colSpan={4} className={`${textClass} ${lineClasses.hunk}`}>
                  {left.text}
                </td>
              ) : (
                <>
                  <LineCells line={left} number={left?.oldNumber} />
                  <LineCells line={right} number={right?.newNumber} />
                </>
              )}
            </tr>
          ))}
    </tbody>
  </table>
)

export const FileDiffList = ({ changes }: { changes: readonly FileChange[] }) => {
  const layout = diffLayoutFor(usePanel().width)
  const [toggledPaths, setToggledPaths] = useState<ReadonlySet<string>>(new Set())
  const isCollapsed = isCollapsedByDefault(changes)
  const toggle = (path: string) => {
    const toggled = new Set(toggledPaths)
    if (!toggled.delete(path)) toggled.add(path)
    setToggledPaths(toggled)
  }
  if (changes.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {changes.map((change) => {
        const isExpanded = toggledPaths.has(change.path) === isCollapsed
        return (
          <section
            key={change.path}
            aria-label={`Changes in ${change.path}`}
            className="overflow-hidden rounded-md border border-line"
          >
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => toggle(change.path)}
              className={`flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-left text-sm hover:bg-hover ${focusRing}`}
            >
              <ChevronRight aria-hidden className={`size-4 shrink-0 text-muted ${isExpanded ? 'rotate-90' : ''}`} />
              <span className="mr-auto break-all">{change.path}</span>
              <span className="font-mono text-xs text-muted">
                {change.status} +{change.additions} −{change.deletions}
              </span>
            </button>
            {isExpanded && <DiffTable change={change} layout={layout} />}
          </section>
        )
      })}
    </div>
  )
}
