import { adminRoleId, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { Name } from './name.ts'

export type Workspace = Readonly<{ id: WorkspaceId; name: Name }>

export type Membership = Readonly<{ memberId: MemberId; workspaceId: WorkspaceId; role: string }>

export const founderMembership = (workspaceId: WorkspaceId, founderId: MemberId): Membership => ({
  memberId: founderId,
  workspaceId,
  role: adminRoleId,
})

export const workspaceDeletionGraceMilliseconds = 7 * 24 * 60 * 60 * 1000
export const purgeStages = ['release', 'delete'] as const
export type PurgeStage = (typeof purgeStages)[number]
export const haltAfterJobLeaseMilliseconds = 6 * 60 * 1000
