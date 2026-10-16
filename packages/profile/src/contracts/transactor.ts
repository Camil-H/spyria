import type { Transactor } from '@hq/kernel'
import type {
  GatewayJobs,
  LlmCredentialRepository,
  MemberGatewayKeyRepository,
  MemberRepository,
  PersonalConnectionRepository,
} from './repositories.ts'

export type UnitOfWork = {
  members: MemberRepository
  llmCredentials: LlmCredentialRepository
  memberGatewayKeys: MemberGatewayKeyRepository
  gatewayJobs: GatewayJobs
  personalConnections: PersonalConnectionRepository
}

export type ProfileTransactor = Transactor<UnitOfWork>
