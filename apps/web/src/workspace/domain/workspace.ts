import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { Name } from './name.ts'

export type Workspace = Readonly<{ id: WorkspaceId; name: Name }>

export type Membership = Readonly<{ memberId: MemberId; workspaceId: WorkspaceId }>
