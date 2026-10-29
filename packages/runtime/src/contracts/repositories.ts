import type { ChatId, HarnessId, MemberId, RuntimeHostId, RuntimeId, WorkspaceId } from '@spyria/kernel'
import type { HostLoad, Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

type HostSecret = 'claimCode' | 'token'

export type RuntimeHostRepository = {
  add(host: RuntimeHost): Promise<void>
  get(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost>
  find(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost | undefined>
  save(host: RuntimeHost): Promise<void>
  setSecretHash(host: RuntimeHost, secret: HostSecret, hash: string | null): Promise<void>
  findBySecretHash(secret: HostSecret, hash: string): Promise<{ host: RuntimeHost; claimed: boolean } | undefined>
  lockLoads(workspaceId: WorkspaceId, chatId: ChatId): Promise<HostLoad[]>
  listMachines(workspaceId: WorkspaceId): Promise<RuntimeHost[]>
  expireClaims(workspaceId: WorkspaceId, now: number): Promise<void>
}

export type WorkspaceSettings = {
  lockMember(workspaceId: WorkspaceId, memberId: MemberId): Promise<void>
  localSessionsOf(workspaceId: WorkspaceId): Promise<boolean>
  setLocalSessions(workspaceId: WorkspaceId, isOn: boolean): Promise<void>
}

export type RuntimeRepository = {
  lock(workspaceId: WorkspaceId, runtimeId: RuntimeId): Promise<Runtime>
  lockByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  lockOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<Runtime[]>
  lockWaitingOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<Runtime[]>
  lockSweepable(workspaceId: WorkspaceId): Promise<Runtime[]>
  findByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  localHarnessOf(runtime: Runtime): Promise<HarnessId | undefined>
  add(runtime: Runtime): Promise<void>
  save(runtime: Runtime): Promise<void>
  delete(runtime: Runtime): Promise<void>
  setHostOnline(workspaceId: WorkspaceId, hostId: RuntimeHostId, isOnline: boolean): Promise<void>
  agentConversationOf(runtime: Runtime): Promise<string | undefined>
  rememberAgentConversation(runtime: Runtime, conversationId: string): Promise<string>
  forgetAgentConversation(runtime: Runtime): Promise<void>
  workspaceSnapshotOf(runtime: Runtime): Promise<string | undefined>
  keepWorkspaceSnapshot(runtime: Runtime, snapshot: string): Promise<void>
  chatOfLlmTokenHash(workspaceId: WorkspaceId, hostId: RuntimeHostId, hash: string): Promise<ChatId | undefined>
}

type RuntimeSecret = 'llmTokenHash' | 'llmSwitchTokenHash'
export type RuntimeSecrets = {
  keep(runtime: Runtime, secret: RuntimeSecret, value: string | null): Promise<void>
  discard(runtime: Runtime): Promise<void>
}

export type JobQueue = {
  enqueue(workspaceId: WorkspaceId, type: string, payload: object, delayMilliseconds?: number): Promise<void>
}
