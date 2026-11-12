import type { MemberId, Transactor, WorkspaceId } from '@spyria/kernel'
import type {
  AiProviderRepository,
  GatewayJobs,
  LlmCredentialRepository,
  MemberGatewayKeyRepository,
  MemberRepository,
  ToolApprovalRepository,
  ToolConnectionRepository,
  WorkspaceConnectionRepository,
  WorkspaceEventLog,
} from './repositories.ts'

export type UnitOfWork = {
  members: MemberRepository
  llmCredentials: LlmCredentialRepository
  aiProviders: AiProviderRepository
  memberGatewayKeys: MemberGatewayKeyRepository
  gatewayJobs: GatewayJobs
  toolConnections: ToolConnectionRepository
  toolApprovals: ToolApprovalRepository
  workspaceConnections: WorkspaceConnectionRepository
  workspaceEvents: WorkspaceEventLog
}

export type ActingMember = Readonly<{ workspaceId: WorkspaceId; memberId: MemberId }>

export type ProfileTransactor = Transactor<UnitOfWork> & { member: ActingMember }
