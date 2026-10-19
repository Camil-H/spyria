import { ownedBy, type Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const hasLlmCredential = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.llmCredentials.some(ownedBy(workspaceId, memberId))
