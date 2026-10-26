export const workspaceReads = ['tree', 'file', 'changes', 'status'] as const
export type WorkspaceRead = (typeof workspaceReads)[number]
type WorkspaceSnapshot = { tree?: object; changes?: object; status?: object }
export type WorkspaceReading = Readonly<{ isLive: boolean; [field: string]: unknown }>

export const branchReads: readonly WorkspaceRead[] = ['changes', 'status']

export const isWorkspaceRead = (read: string): read is WorkspaceRead => workspaceReads.some((known) => known === read)

export const agentWorkspacePathOf = (read: WorkspaceRead, path: string, baseBranch: string) =>
  `/api/workspace/${read}?${new URLSearchParams(branchReads.includes(read) ? { base: baseBranch } : { path })}`

export const runtimeHeadsOf = (status: object | undefined) => {
  const { head, baseHead } = (status ?? {}) as { head?: unknown; baseHead?: unknown }
  return [head, baseHead].filter((commit): commit is string => typeof commit === 'string')
}

export const snapshotReadingOf = (snapshot: string | undefined, read: WorkspaceRead, path: string) => {
  const { tree, changes, status } = JSON.parse(snapshot ?? '{}') as WorkspaceSnapshot
  if (read === 'tree' && path === '') return tree
  return read === 'changes' ? changes : read === 'status' ? status : undefined
}
