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
const numberClass = 'w-px whitespace-nowrap select-none px-1 text-right align-top text-muted tabular-nums'
const textClass = 'whitespace-pre px-2 align-top'
const splitTextClass = 'w-1/2'

const lineKeyOf = (line: DiffLine | null) =>
  line ? `${line.kind}:${line.oldNumber}:${line.newNumber}:${line.kind === 'hunk' ? line.text : ''}` : 'none'

const LineCells = ({
  line,
  number,
  widthClass = '',
}: {
  line: DiffLine | null
  number: number | null | undefined
  widthClass?: string
}) => (
  <>
    <td className={`${numberClass} ${line ? lineClasses[line.kind] : ''}`}>{number ?? ''}</td>
    <td className={`${textClass} ${widthClass} ${line ? lineClasses[line.kind] : ''}`}>
      {line && `${markers[line.kind]} ${line.text}`}
    </td>
  </>
)

const DiffTable = ({ change, layout }: { change: FileChange; layout: DiffLayout }) => (
  <div className="overflow-x-auto border-t border-line scrollbar-thin">
    <table aria-label={`Diff of ${change.path}`} className="w-full font-mono text-xs">
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
                    <LineCells line={left} number={left?.oldNumber} widthClass={splitTextClass} />
                    <LineCells line={right} number={right?.newNumber} widthClass={splitTextClass} />
                  </>
                )}
              </tr>
            ))}
      </tbody>
    </table>
  </div>
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
