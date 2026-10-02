import type { MemberId } from '@hq/kernel'
import type { DisplayName } from './display-name.ts'

export type Member = { id: MemberId; name: DisplayName }

export const renameMember = (member: Member, name: DisplayName): Member => ({ ...member, name })
