import type {
  AiProviderAllowList,
  CredentialId,
  GatewayKey,
  MemberId,
  ToolApprovalPreference,
  WorkspaceId,
  WorkspacePermission,
} from '@spyria/kernel'
import type { LlmCredential } from '../domain/llm-credential.ts'
import type { Member } from '../domain/member.ts'
import type { Secret } from '../domain/secret.ts'
import type { ToolConnection } from '../domain/tool-connection.ts'
import type {
  AccessSubject,
  ConnectionTool,
  SecretHeader,
  ToolHolder,
  ToolServerAccess,
  WorkspaceConnection,
} from '../domain/workspace-connection.ts'

export type MemberRepository = {
  get(): Promise<Member>
  save(member: Member): Promise<void>
  permissions(): Promise<readonly WorkspacePermission[]>
  isActive(workspaceId: WorkspaceId, memberId: MemberId): Promise<boolean>
  lockActive(): Promise<void>
  holders(workspaceId: WorkspaceId): Promise<ToolHolder[]>
  roleIds(workspaceId: WorkspaceId): Promise<string[]>
}

export type LlmCredentialRepository = {
  add(credential: LlmCredential, key: GatewayKey): Promise<void>
  remove(credentialId: CredentialId): Promise<GatewayKey | undefined>
  removeAll(): Promise<GatewayKey[]>
  gatewayKeys(): Promise<GatewayKey[]>
}

export type AiProviderRepository = {
  allowList(): Promise<AiProviderAllowList | null>
  setAllowList(allowList: AiProviderAllowList | null): Promise<void>
}

export type MemberGatewayKeyRepository = {
  virtualKey(): Promise<string | undefined>
  setVirtualKey(virtualKeyId: string | null): Promise<void>
  virtualKeysIn(workspaceId: WorkspaceId): Promise<{ memberId: MemberId; virtualKeyId: string }[]>
}

export type GatewaySyncJob = { workspaceId: WorkspaceId; memberId: MemberId; key?: GatewayKey; isLeaving?: boolean }
export type ToolServerRemovalJob = { workspaceId: WorkspaceId; gatewayName: string }
export type GatewayJobs = {
  syncLater(job: Pick<GatewaySyncJob, 'key' | 'isLeaving'>): Promise<void>
  removeToolServerLater(job: ToolServerRemovalJob): Promise<void>
}

export type LlmGateway = {
  addProviderKey(key: { provider: string; name: string; secret: Secret }): Promise<GatewayKey>
  removeProviderKey(key: GatewayKey): Promise<void>
  saveVirtualKey(virtualKey: { id: string | undefined; keys: GatewayKey[] }): Promise<string>
  removeVirtualKey(id: string): Promise<void>
  virtualKeyValue(id: string): Promise<string | undefined>
}

export type ToolConnectionRepository = {
  connect(connection: ToolConnection): Promise<void>
  disconnect(connectionId: string): Promise<void>
  statusOf(connectionId: string): Promise<string | undefined>
  connectionIds(): Promise<string[]>
  removeAll(): Promise<void>
}

export type WorkspaceConnectionRepository = {
  list(workspaceId: WorkspaceId): Promise<WorkspaceConnection[]>
  get(workspaceId: WorkspaceId, connectionId: string): Promise<WorkspaceConnection>
  findByGatewayName(workspaceId: WorkspaceId, gatewayName: string): Promise<WorkspaceConnection | undefined>
  findByName(workspaceId: WorkspaceId, name: string): Promise<WorkspaceConnection | undefined>
  add(connection: WorkspaceConnection): Promise<void>
  save(connection: WorkspaceConnection): Promise<void>
  remove(workspaceId: WorkspaceId, connectionId: string): Promise<void>
  accessOf(workspaceId: WorkspaceId): Promise<ToolServerAccess[]>
  setAccess(
    workspaceId: WorkspaceId,
    connectionId: string,
    subject: AccessSubject,
    access: ToolServerAccess | null,
  ): Promise<void>
  removeAccessOf(workspaceId: WorkspaceId, memberId: MemberId): Promise<void>
  removeSignIn(workspaceId: WorkspaceId, connectionId: string, memberId: MemberId): Promise<void>
}

export type ToolApprovalRepository = {
  get(connectionId: string): Promise<ToolApprovalPreference | undefined>
  ofMember(memberId: MemberId, connectionId: string): Promise<ToolApprovalPreference | undefined>
  save(preference: ToolApprovalPreference): Promise<void>
  removeAll(): Promise<void>
}

export type WorkspaceEventLog = {
  record(event: { workspaceId: WorkspaceId; type: string; payload: object }): Promise<void>
}

export type ToolServer = { id: string; name: string; tools: string[] }
export type ToolGateway = {
  toolServers(): Promise<ToolServer[]>
  addToolServer(server: { name: string; url: string; secretHeader?: SecretHeader | null }): Promise<ConnectionTool[]>
  startMemberToolServer(server: { name: string; url: string }): Promise<{ setupId: string; authorizeUrl: string }>
  finishMemberToolServer(name: string, setupId: string): Promise<ConnectionTool[]>
  replaceToolServerHeader(name: string, secretHeader: SecretHeader | null): Promise<void>
  removeToolServer(name: string): Promise<void>
  setToolGrants(virtualKeyId: string, workspaceGrants: Record<string, string[]>): Promise<void>
  startToolConsent(virtualKeyId: string, server: ToolServer): Promise<string>
  toolSessions(virtualKeyId: string, server: ToolServer): Promise<{ id: string; status: string }[]>
  isToolSessionAuthorized(virtualKeyId: string, server: ToolServer): Promise<boolean | undefined>
  removeToolSession(sessionId: string): Promise<void>
  finishToolConsent(callbackQuery: string): Promise<boolean>
}
