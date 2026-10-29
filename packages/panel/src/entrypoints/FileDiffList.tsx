import { focusRing } from '@spyria/ui'
import { ChevronRight } from 'lucide-react'
import {
  type DiffLayout,
  type DiffLine,
  diffLayoutFor,
  type FileChange,
  lineNumberDigitsOf,
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
const textClass = 'px-2 align-top'
const unifiedTextClass = 'whitespace-pre'
const splitTextClass = 'whitespace-pre-wrap break-words'

const lineKeyOf = (line: DiffLine | null) =>
  line ? `${line.kind}:${line.oldNumber}:${line.newNumber}:${line.kind === 'hunk' ? line.text : ''}` : 'none'

const numberPadding = '0.5rem'

const LineCells = ({
  line,
  number,
  wrapClass = unifiedTextClass,
}: {
  line: DiffLine | null
  number: number | null | undefined
  wrapClass?: string
}) => (
  <>
    <td className={`${numberClass} ${line ? lineClasses[line.kind] : ''}`}>{number ?? ''}</td>
    <td className={`${textClass} ${wrapClass} ${line ? lineClasses[line.kind] : ''}`}>
      {line && `${markers[line.kind]} ${line.text}`}
    </td>
  </>
)

const UnifiedTable = ({ change, label }: { change: FileChange; label: string }) => (
  <table aria-label={`Diff of ${label}`} className="w-full font-mono text-xs">
    <tbody>
      {change.lines.map((line) => (
        <tr key={lineKeyOf(line)}>
          <td className={`${numberClass} ${lineClasses[line.kind]}`}>{line.oldNumber ?? ''}</td>
          <LineCells line={line} number={line.newNumber} />
        </tr>
      ))}
    </tbody>
  </table>
)

const SplitTable = ({ change, label }: { change: FileChange; label: string }) => {
  const numberWidth = `calc(${lineNumberDigitsOf(change.lines)}ch + ${numberPadding})`
  return (
    <table aria-label={`Diff of ${label}`} className="w-full table-fixed font-mono text-xs">
      <colgroup>
        <col style={{ width: numberWidth }} />
        <col />
        <col style={{ width: numberWidth }} />
        <col />
      </colgroup>
      <tbody>
        {splitRowsOf(change.lines).map(({ left, right }) => (
          <tr key={`${lineKeyOf(left)}|${lineKeyOf(right)}`}>
            {left?.kind === 'hunk' ? (
              <td colSpan={4} className={`${textClass} ${splitTextClass} ${lineClasses.hunk}`}>
                {left.text}
              </td>
            ) : (
              <>
                <LineCells line={left} number={left?.oldNumber} wrapClass={splitTextClass} />
                <LineCells line={right} number={right?.newNumber} wrapClass={splitTextClass} />
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const DiffTable = ({ change, label, layout }: { change: FileChange; label: string; layout: DiffLayout }) => (
  <div className="overflow-x-auto border-t border-line scrollbar-thin">
    {layout === 'unified' ? (
      <UnifiedTable change={change} label={label} />
    ) : (
      <SplitTable change={change} label={label} />
    )}
  </div>
)

export const FileDiffList = ({
  changes,
  groupName,
  isExpanded,
  onToggle,
}: {
  changes: readonly FileChange[]
  groupName: string
  isExpanded: (path: string) => boolean
  onToggle: (path: string) => void
}) => {
  const layout = diffLayoutFor(usePanel().width)
  if (changes.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {changes.map((change) => {
        const isOpen = isExpanded(change.path)
        const label = groupName ? `${change.path} (${groupName})` : change.path
        return (
          <section
            key={change.path}
            aria-label={`Changes in ${label}`}
            className="overflow-hidden rounded-md border border-line"
          >
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => onToggle(change.path)}
              className={`flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-left text-sm hover:bg-hover ${focusRing}`}
            >
              <ChevronRight aria-hidden className={`size-4 shrink-0 text-muted ${isOpen ? 'rotate-90' : ''}`} />
              <span className="mr-auto break-all">{change.path}</span>
              <span className="font-mono text-xs text-muted">
                {change.status} +{change.additions} −{change.deletions}
              </span>
            </button>
            {isOpen && <DiffTable change={change} label={label} layout={layout} />}
          </section>
        )
      })}
    </div>
  )
}
