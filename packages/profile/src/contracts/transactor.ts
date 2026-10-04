import type {
  LlmCredentialRepository,
  MemberRepository,
  PersonalConnectionRepository,
  SecretStore,
} from './repositories.ts'

export type UnitOfWork = {
  members: MemberRepository
  llmCredentials: LlmCredentialRepository
  secrets: SecretStore
  personalConnections: PersonalConnectionRepository
}

export type ProfileTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
