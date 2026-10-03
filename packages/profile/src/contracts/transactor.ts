import type { LlmCredentialRepository, MemberRepository, PersonalConnectionRepository } from './repositories.ts'

export type UnitOfWork = {
  members: MemberRepository
  llmCredentials: LlmCredentialRepository
  personalConnections: PersonalConnectionRepository
}

export type ProfileTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
