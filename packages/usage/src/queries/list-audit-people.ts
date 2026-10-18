import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'

export const listAuditPeople = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.memberships
    .filter((membership) => membership.workspaceId === workspaceId)
    .map((membership) => ({ id: membership.memberId, name: membership.displayName }))
    .toSorted((first, second) => first.name.localeCompare(second.name))
