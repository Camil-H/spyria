import type { WorkspaceId } from '@spyria/kernel'

const listenersByWorkspace = new Map<WorkspaceId, Set<() => void>>()

export const watchToolLists = (workspaceId: WorkspaceId, onChange: () => void) => {
  const listeners = listenersByWorkspace.get(workspaceId) ?? new Set()
  listenersByWorkspace.set(workspaceId, listeners.add(onChange))
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) listenersByWorkspace.delete(workspaceId)
  }
}

export const announceToolListChange = (workspaceId: WorkspaceId) => {
  for (const onChange of listenersByWorkspace.get(workspaceId) ?? []) onChange()
}
