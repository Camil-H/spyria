import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { Name } from './name.ts'

export type Workspace = Readonly<{ id: WorkspaceId; name: Name }>

export type Membership = Readonly<{ memberId: MemberId; workspaceId: WorkspaceId }>
