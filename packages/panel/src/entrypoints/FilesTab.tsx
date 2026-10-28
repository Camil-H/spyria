import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { focusRing } from '@spyria/ui'
import { ArrowLeft, ChevronDown, ChevronRight, FolderTree } from 'lucide-react'
import { Suspense, useState } from 'react'
import {
  changeMarkOf,
  codeFenceOf,
  type FileChange,
  fileChangesOf,
  type TreeEntry,
  treeEntriesOf,
} from '../domain/workspace.ts'
import { EmptyState } from './EmptyState.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'
import { useWorkspaceReading } from './useWorkspaceReading.ts'
import { WorkspaceStatus } from './WorkspaceStatus.tsx'

type TreeProps = {
  workspaceId: WorkspaceId
  chatId: ChatId
  changes: readonly FileChange[]
  onOpen: (path: string) => void
}

const markLetters: Record<string, string> = { Added: 'A', Modified: 'M', Deleted: 'D', 'Contains changes': '•' }
const rowClass = `flex w-full cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-hover ${focusRing}`

const ChangeMark = ({ mark }: { mark: string | undefined }) =>
  mark ? (
    <span role="img" aria-label={mark} title={mark} className="ml-auto font-mono text-xs text-accent">
      {markLetters[mark]}
    </span>
  ) : null

const TreeItem = ({ entry, ...tree }: TreeProps & { entry: TreeEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const mark = changeMarkOf(entry, tree.changes)
  if (!entry.isFolder)
    return (
      <li>
        <button type="button" onClick={() => tree.onOpen(entry.path)} className={`${rowClass} pl-5`}>
          <span className="truncate">{entry.name}</span>
          <ChangeMark mark={mark} />
        </button>
      </li>
    )
  const Chevron = isExpanded ? ChevronDown : ChevronRight
  return (
    <li>
      <button type="button" aria-expanded={isExpanded} onClick={() => setIsExpanded(!isExpanded)} className={rowClass}>
        <Chevron aria-hidden size={14} className="shrink-0" />
        <span className="truncate">{entry.name}</span>
        <ChangeMark mark={mark} />
      </button>
      {isExpanded && (
        <div className="ml-4">
          <TreeLevel path={entry.path} {...tree} />
        </div>
      )}
    </li>
  )
}

const TreeLevel = ({ path, ...tree }: TreeProps & { path: string }) => {
  const { reading } = useWorkspaceReading(tree.workspaceId, tree.chatId, 'tree', path)
  const entries = treeEntriesOf(reading)
  if (!reading) return null
  if (entries.length === 0 && path === '')
    return (
      <EmptyState Icon={FolderTree} title="No files" hint="The runtime's workspace shows here once the agent starts." />
    )
  if (entries.length === 0) return <p className={emptyClass}>Empty folder</p>
  return (
    <>
      <ul className="flex flex-col text-sm">
        {entries.map((entry) => (
          <TreeItem key={entry.path} entry={entry} {...tree} />
        ))}
      </ul>
      {reading.truncated === true && <p className={emptyClass}>Listing truncated</p>}
    </>
  )
}

const FileViewer = ({ workspaceId, chatId, path, Markdown }: TabProps & { path: string }) => {
  const { reading } = useWorkspaceReading(workspaceId, chatId, 'file', path)
  if (!reading) return null
  if (typeof reading.content !== 'string') return <p className={emptyClass}>This file cannot be read now</p>
  if (reading.isBinary === true) return <p className={emptyClass}>Binary file</p>
  return (
    <>
      <Suspense fallback={<pre className="text-xs whitespace-pre-wrap">{reading.content}</pre>}>
        <Markdown text={codeFenceOf(path, reading.content)} />
      </Suspense>
      {reading.truncated === true && <p className={emptyClass}>File truncated</p>}
    </>
  )
}

export const FilesTab = (props: TabProps) => {
  const { workspaceId, chatId } = props
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const { reading } = useWorkspaceReading(workspaceId, chatId, 'changes')
  const changes = fileChangesOf(reading?.patch)
  return (
    <>
      <WorkspaceStatus workspaceId={workspaceId} chatId={chatId} />
      {openedPath === null ? (
        <TreeLevel path="" workspaceId={workspaceId} chatId={chatId} changes={changes} onOpen={setOpenedPath} />
      ) : (
        <section aria-label={openedPath} className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setOpenedPath(null)}
            className={`flex items-center gap-1 self-start rounded-md px-1 text-sm text-muted hover:text-ink ${focusRing}`}
          >
            <ArrowLeft aria-hidden size={14} />
            All files
          </button>
          <h2 className="break-all font-mono text-xs">{openedPath}</h2>
          <FileViewer {...props} path={openedPath} />
        </section>
      )}
    </>
  )
}
