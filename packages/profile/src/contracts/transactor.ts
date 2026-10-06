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

export type ProfileTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
