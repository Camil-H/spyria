import { ownedBy, type Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getLlmCredentials = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.llmCredentials
    .filter(ownedBy(workspaceId, memberId))
    .map(({ id, provider, last4 }) => ({ id, provider, last4 }))
