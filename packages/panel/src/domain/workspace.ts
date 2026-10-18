export type WorkspaceRead = 'tree' | 'file' | 'changes'
export type WorkspaceReading = Readonly<{ isLive: boolean; [field: string]: unknown }>
export type DiffLine = { kind: 'added' | 'removed' | 'context'; text: string }
export type FileStatus = 'Added' | 'Modified' | 'Deleted'
export type FileChange = { path: string; status: FileStatus; additions: number; deletions: number; lines: DiffLine[] }
export type TreeEntry = { name: string; path: string; isFolder: boolean }
export type Commit = { sha: string; subject: string; author: string; committedAt: string }

const lineKinds: Record<string, DiffLine['kind']> = { '+': 'added', '-': 'removed', ' ': 'context', '@': 'context' }

const pathOf = (header: string, lines: readonly string[]) => {
  const target = lines.find((line) => line.startsWith('+++ b/'))
  const source = lines.find((line) => line.startsWith('--- a/'))
  return (target ?? source)?.slice(6) ?? header.slice(header.lastIndexOf(' b/') + 3)
}

const fileChangeOf = (section: string): FileChange => {
  const [header = '', ...lines] = section.split('\n')
  const hunkStart = lines.findIndex((line) => line.startsWith('@@'))
  const body = hunkStart < 0 ? [] : lines.slice(hunkStart).filter((line) => line[0] && line[0] in lineKinds)
  const diffLines = body.map((line) => ({
    kind: lineKinds[line[0] ?? ' '] ?? 'context',
    text: line.startsWith('@@') ? line : line.slice(1),
  }))
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
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha = '', subject = '', author = '', committedAt = ''] = line.split('\x1f')
          const time = Date.parse(committedAt)
          return {
            sha: sha.slice(0, 7),
            subject,
            author,
            committedAt: Number.isNaN(time) ? '' : new Date(time).toISOString(),
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
