import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { DisplayName } from './display-name.ts'

export type Member = { workspaceId: WorkspaceId; id: MemberId; name: DisplayName }
