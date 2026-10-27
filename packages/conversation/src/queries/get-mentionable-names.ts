import type { Snapshot } from '@spyria/db'
import type { WorkspaceId } from '@spyria/kernel'

export const getMentionableNames = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.memberships
    .filter(
      (membership) =>
        membership.workspaceId === workspaceId && membership.removedAt === null && membership.displayName !== '',
    )
    .map((membership) => membership.displayName)
    .toSorted((first, second) => first.localeCompare(second))
