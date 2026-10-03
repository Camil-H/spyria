import type { MemberId } from '@hq/kernel'
import type { DisplayName } from './display-name.ts'

export type Member = { id: MemberId; name: DisplayName }

export const renamedMember = (member: Member, name: DisplayName): Member => ({ ...member, name })
