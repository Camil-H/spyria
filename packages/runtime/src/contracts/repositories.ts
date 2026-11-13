import type { ChatId, HarnessId, MemberId, RuntimeHostId, RuntimeId, WarmPool, WorkspaceId } from '@spyria/kernel'
import type { HostLoad, IdleCutoffs, Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'
import type { ClaimScope, SetupSnapshotScope, WarmRuntime } from '../domain/warm-runtime.ts'
import type { PackageCacheScope } from './sandbox-provider.ts'

type HostSecret = 'claimCode' | 'token'

export type RuntimeHostRepository = {
  add(host: RuntimeHost): Promise<void>
  get(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost>
  find(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost | undefined>
  save(host: RuntimeHost): Promise<void>
  setSecretHash(host: RuntimeHost, secret: HostSecret, hash: string | null): Promise<void>
  findBySecretHash(secret: HostSecret, hash: string): Promise<{ host: RuntimeHost; claimed: boolean } | undefined>
  lockLoads(workspaceId: WorkspaceId, chatId: ChatId): Promise<HostLoad[]>
  lockWorkspaceLoads(workspaceId: WorkspaceId): Promise<HostLoad[]>
  listMachines(workspaceId: WorkspaceId): Promise<RuntimeHost[]>
  listOnline(workspaceId: WorkspaceId): Promise<RuntimeHost[]>
  expireClaims(workspaceId: WorkspaceId, now: number): Promise<void>
}

export type WorkspaceSettings = {
  lockMember(workspaceId: WorkspaceId, memberId: MemberId): Promise<void>
  localSessionsOf(workspaceId: WorkspaceId): Promise<boolean>
  setLocalSessions(workspaceId: WorkspaceId, isOn: boolean): Promise<void>
  warmPoolsOf(workspaceId: WorkspaceId): Promise<WarmPool[]>
}

export type RuntimeRepository = {
  lock(workspaceId: WorkspaceId, runtimeId: RuntimeId): Promise<Runtime>
  lockByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  lockOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<Runtime[]>
  lockWaitingOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<Runtime[]>
  lockIdle(workspaceId: WorkspaceId, cutoffs: IdleCutoffs): Promise<Runtime[]>
  findByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  findByIds(workspaceId: WorkspaceId, ids: readonly string[]): Promise<Runtime[]>
  launchOptionsOf(
    runtime: Runtime,
  ): Promise<{ harness?: HarnessId; packageCache?: PackageCacheScope; setupSnapshot?: SetupSnapshotScope }>
  claimScopeOf(workspaceId: WorkspaceId, chatId: ChatId): Promise<ClaimScope | undefined>
  add(runtime: Runtime): Promise<void>
  save(runtime: Runtime): Promise<void>
  delete(runtime: Runtime): Promise<void>
  setHostOnline(workspaceId: WorkspaceId, hostId: RuntimeHostId, isOnline: boolean): Promise<void>
  agentConversationOf(runtime: Runtime): Promise<string | undefined>
  rememberAgentConversation(runtime: Runtime, conversationId: string): Promise<string>
  forgetAgentConversation(runtime: Runtime): Promise<void>
  workspaceSnapshotOf(runtime: Runtime): Promise<string | undefined>
  keepWorkspaceSnapshot(runtime: Runtime, snapshot: string): Promise<void>
  apiKeyIdOf(runtime: Runtime): Promise<string | undefined>
  keepApiKeyId(runtime: Runtime, apiKeyId: string): Promise<void>
  chatOfLlmTokenHash(workspaceId: WorkspaceId, hostId: RuntimeHostId, hash: string): Promise<ChatId | undefined>
}

export type WarmRuntimeRepository = {
  lockAll(workspaceId: WorkspaceId): Promise<WarmRuntime[]>
  lock(workspaceId: WorkspaceId, id: RuntimeId): Promise<WarmRuntime | undefined>
  lockClaimable(workspaceId: WorkspaceId, scope: ClaimScope, image: string): Promise<WarmRuntime | undefined>
  lockOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<WarmRuntime[]>
  findByIds(workspaceId: WorkspaceId, ids: readonly string[]): Promise<WarmRuntime[]>
  add(warm: WarmRuntime): Promise<void>
  save(warm: WarmRuntime): Promise<void>
  delete(warm: WarmRuntime): Promise<void>
}

export type RepositoryAccess = {
  cloneOf(workspaceId: WorkspaceId, repository: string): Promise<{ url: string; token: string }>
}

export type RuntimeSecrets = {
  keepLlmTokenHash(runtime: Runtime, hash: string): Promise<void>
  discard(runtime: Runtime): Promise<void>
}

export type JobQueue = {
  enqueue(workspaceId: WorkspaceId, type: string, payload: object, delayMilliseconds?: number): Promise<void>
}
