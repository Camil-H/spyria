import type { MemberId, Transactor, WorkspaceId } from '@spyria/kernel'
import type {
  GatewayJobs,
  LlmCredentialRepository,
  MemberGatewayKeyRepository,
  MemberRepository,
  PersonalConnectionRepository,
  WorkspaceConnectionRepository,
  WorkspaceEventLog,
} from './repositories.ts'

export type UnitOfWork = {
  members: MemberRepository
  llmCredentials: LlmCredentialRepository
  memberGatewayKeys: MemberGatewayKeyRepository
  gatewayJobs: GatewayJobs
  personalConnections: PersonalConnectionRepository
  workspaceConnections: WorkspaceConnectionRepository
  workspaceEvents: WorkspaceEventLog
}

export type ActingMember = Readonly<{ workspaceId: WorkspaceId; memberId: MemberId }>

export type ProfileTransactor = Transactor<UnitOfWork> & { member: ActingMember }
