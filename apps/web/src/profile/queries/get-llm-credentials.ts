import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getLlmCredentials = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.llmCredentials
    .filter(ownedBy(workspaceId, memberId))
    .map(({ id, provider, kind, label, last4, status }) => ({ id, provider, kind, label, last4, status }))
