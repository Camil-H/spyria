import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import type { LlmCredential } from '../domain/llm-credential.ts'
import type { Member } from '../domain/member.ts'
import type { PersonalConnection } from '../domain/personal-connection.ts'

export type MemberRepository = {
  get(workspaceId: WorkspaceId, memberId: MemberId): Promise<Member>
  save(member: Member): Promise<void>
}

export type LlmCredentialRepository = {
  add(credential: LlmCredential): Promise<void>
  remove(workspaceId: WorkspaceId, memberId: MemberId, credentialId: CredentialId): Promise<void>
}

export type PersonalConnectionRepository = {
  list(workspaceId: WorkspaceId, memberId: MemberId): Promise<readonly PersonalConnection[]>
  replace(workspaceId: WorkspaceId, memberId: MemberId, connections: readonly PersonalConnection[]): Promise<void>
  toolCatalog(): Promise<readonly string[]>
}
