import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import type { LlmCredential, SecretRef } from '../domain/llm-credential.ts'
import type { Member } from '../domain/member.ts'
import type { PersonalConnection } from '../domain/personal-connection.ts'
import type { Secret } from '../domain/secret.ts'

export type MemberRepository = {
  get(workspaceId: WorkspaceId, memberId: MemberId): Promise<Member>
  save(member: Member): Promise<void>
}

export type LlmCredentialRepository = {
  add(credential: LlmCredential, secretRef: SecretRef): Promise<void>
  remove(workspaceId: WorkspaceId, memberId: MemberId, credentialId: CredentialId): Promise<SecretRef | null>
}

export type SecretStore = {
  keep(workspaceId: WorkspaceId, secret: Secret): Promise<SecretRef>
  discard(workspaceId: WorkspaceId, secretRef: SecretRef): Promise<void>
}

export type PersonalConnectionRepository = {
  list(workspaceId: WorkspaceId, memberId: MemberId): Promise<readonly PersonalConnection[]>
  replace(workspaceId: WorkspaceId, memberId: MemberId, connections: readonly PersonalConnection[]): Promise<void>
  toolCatalog(): Promise<readonly string[]>
}
