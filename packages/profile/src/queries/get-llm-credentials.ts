import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getLlmCredentials = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.llmCredentials
    .filter(ownedBy(workspaceId, memberId))
    .map(({ id, provider, last4 }) => ({ id, provider, last4 }))
