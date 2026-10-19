import type { Transactor } from '@spyria/kernel'
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

export type ProfileTransactor = Transactor<UnitOfWork>
