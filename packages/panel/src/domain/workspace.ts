export type WorkspaceRead = 'tree' | 'file' | 'changes' | 'status'
export type WorkspaceReading = Readonly<{ isLive: boolean; [field: string]: unknown }>
export type DiffLine = {
  kind: 'added' | 'removed' | 'context' | 'hunk'
  text: string
  oldNumber: number | null
  newNumber: number | null
}
export type DiffRow = { left: DiffLine | null; right: DiffLine | null }
export type DiffLayout = 'unified' | 'split'
export type FileStatus = 'Added' | 'Modified' | 'Deleted'
export type FileChange = { path: string; status: FileStatus; additions: number; deletions: number; lines: DiffLine[] }
export type TreeEntry = { name: string; path: string; isFolder: boolean }
export type Commit = { sha: string; subject: string; author: string; committedAt: string; body: string }
export type BranchStatus = {
  aheadOfBase?: number
  behindBase?: number
  aheadOfPushed?: number
  behindPushed?: number
  uncommitted?: number
  pushedAt?: string
}

const lineKinds: Record<string, DiffLine['kind']> = { '+': 'added', '-': 'removed', ' ': 'context', '@': 'hunk' }
const hunkPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)/
const collapsedAboveLines = 400
const splitFromPanelWidth = 560
const minimumLineNumberDigits = 4

const pathOf = (header: string, lines: readonly string[]) => {
  const target = lines.find((line) => line.startsWith('+++ b/'))
  const source = lines.find((line) => line.startsWith('--- a/'))
  return (target ?? source)?.slice(6) ?? header.slice(header.lastIndexOf(' b/') + 3)
}

const numberedLinesOf = (body: readonly string[]) => {
  let oldNumber = 0
  let newNumber = 0
  return body.map((line): DiffLine => {
    const kind = lineKinds[line[0] ?? ' '] ?? 'context'
    if (kind === 'hunk') {
      const [, oldStart = '0', newStart = '0'] = hunkPattern.exec(line) ?? []
      oldNumber = Number(oldStart)
      newNumber = Number(newStart)
      return { kind, text: line, oldNumber: null, newNumber: null }
    }
    const numbered = {
      kind,
      text: line.slice(1),
      oldNumber: kind === 'added' ? null : oldNumber,
      newNumber: kind === 'removed' ? null : newNumber,
    }
    if (kind !== 'added') oldNumber += 1
    if (kind !== 'removed') newNumber += 1
    return numbered
  })
}

const fileChangeOf = (section: string): FileChange => {
  const [header = '', ...lines] = section.split('\n')
  const hunkStart = lines.findIndex((line) => line.startsWith('@@'))
  const body = hunkStart < 0 ? [] : lines.slice(hunkStart).filter((line) => line[0] && line[0] in lineKinds)
  const diffLines = numberedLinesOf(body)
  const head = hunkStart < 0 ? lines : lines.slice(0, hunkStart)
  return {
    path: pathOf(header, head),
    status: head.some((line) => line.startsWith('new file mode'))
      ? 'Added'
      : head.some((line) => line.startsWith('deleted file mode'))
        ? 'Deleted'
        : 'Modified',
    additions: diffLines.filter((line) => line.kind === 'added').length,
    deletions: diffLines.filter((line) => line.kind === 'removed').length,
    lines: diffLines,
  }
}

export const fileChangesOf = (patch: unknown) =>
  typeof patch === 'string'
    ? patch
        .split(/^diff --git /m)
        .filter(Boolean)
        .map(fileChangeOf)
    : []

export const commitsOf = (log: unknown): Commit[] =>
  typeof log === 'string'
    ? log
        .split(log.includes('\x1e') ? '\x1e' : '\n')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [sha = '', subject = '', author = '', committedAt = '', body = ''] = record.split('\x1f')
          const time = Date.parse(committedAt)
          return {
            sha: sha.slice(0, 7),
            subject,
            author,
            committedAt: Number.isNaN(time) ? '' : new Date(time).toISOString(),
            body: body.trim(),
          }
        })
    : []

export const treeEntriesOf = (reading: WorkspaceReading | undefined) =>
  Array.isArray(reading?.entries) ? (reading.entries as TreeEntry[]) : []

export const changeMarkOf = (entry: TreeEntry, changes: readonly FileChange[]) => {
  if (!entry.isFolder) return changes.find((change) => change.path === entry.path)?.status
  return changes.some((change) => change.path.startsWith(`${entry.path}/`)) ? 'Contains changes' : undefined
}

export const codeFenceOf = (path: string, content: string) => {
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(([run]) => run.length + 1)))
  return `${fence}${path.split('.').at(-1) ?? ''}\n${content}\n${fence}`
}

export const isCollapsedByDefault = (changes: readonly FileChange[]) =>
  changes.reduce((total, change) => total + change.lines.length, 0) > collapsedAboveLines

export const diffLayoutFor = (panelWidth: number): DiffLayout =>
  panelWidth >= splitFromPanelWidth ? 'split' : 'unified'

export const lineNumberDigitsOf = (lines: readonly DiffLine[]) =>
  lines.reduce(
    (digits, line) => Math.max(digits, String(Math.max(line.oldNumber ?? 0, line.newNumber ?? 0)).length),
    minimumLineNumberDigits,
  )

export const splitRowsOf = (lines: readonly DiffLine[]) => {
  const rows: DiffRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const pairChanges = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1)
      rows.push({ left: removed[index] ?? null, right: added[index] ?? null })
    removed = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'removed') removed.push(line)
    else if (line.kind === 'added') added.push(line)
    else {
      pairChanges()
      rows.push({ left: line, right: line })
    }
  }
  pairChanges()
  return rows
}

const countAgainst = (ahead: number | undefined, behind: number | undefined, target: string, upToDate: string) => {
  if (ahead === undefined || behind === undefined) return []
  if (ahead === 0 && behind === 0) return [upToDate]
  return [...(ahead > 0 ? [`${ahead} ahead of ${target}`] : []), ...(behind > 0 ? [`${behind} behind ${target}`] : [])]
}

export const branchStatusOf = (reading: WorkspaceReading | undefined): BranchStatus => {
  const numberOf = (field: string) => (typeof reading?.[field] === 'number' ? (reading[field] as number) : undefined)
  return {
    aheadOfBase: numberOf('aheadOfBase'),
    behindBase: numberOf('behindBase'),
    aheadOfPushed: numberOf('aheadOfPushed'),
    behindPushed: numberOf('behindPushed'),
    uncommitted: numberOf('uncommitted'),
    pushedAt: typeof reading?.pushedAt === 'string' ? reading.pushedAt : undefined,
  }
}

export const branchStatusPartsOf = (status: BranchStatus, baseBranch: string) => [
  ...countAgainst(status.aheadOfBase, status.behindBase, baseBranch, `Up to date with ${baseBranch}`),
  ...countAgainst(status.aheadOfPushed, status.behindPushed, 'the pushed branch', 'Pushed branch up to date'),
  ...(status.uncommitted === undefined
    ? []
    : [
        status.uncommitted === 0
          ? 'No uncommitted files'
          : `${status.uncommitted} ${status.uncommitted === 1 ? 'file' : 'files'} uncommitted`,
      ]),
]

export const hasNothingToCommit = (status: BranchStatus) => status.uncommitted === 0
export const hasNothingToPush = (status: BranchStatus) =>
  status.aheadOfPushed === 0 || (status.aheadOfPushed === undefined && status.aheadOfBase === 0)

export const conflictPromptOf = (baseBranch: string, conflicts: readonly string[]) =>
  [
    `Merge the latest ${baseBranch} (fetched as refs/spyria/base) into the working branch, resolve the conflicts in these files, then commit:`,
    ...conflicts.map((path) => `- ${path}`),
  ].join('\n')
