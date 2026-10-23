import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { Name } from './name.ts'

export type Workspace = Readonly<{ id: WorkspaceId; name: Name }>

export type Membership = Readonly<{ memberId: MemberId; workspaceId: WorkspaceId }>

export const workspaceDeletionGraceMilliseconds = 7 * 24 * 60 * 60 * 1000
export const purgeStages = ['release', 'delete'] as const
export type PurgeStage = (typeof purgeStages)[number]
