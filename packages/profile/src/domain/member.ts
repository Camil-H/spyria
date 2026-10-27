import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { Avatar } from './avatar.ts'
import type { DisplayName } from './display-name.ts'

export type Member = { workspaceId: WorkspaceId; id: MemberId; name: DisplayName; avatar: Avatar | null }
