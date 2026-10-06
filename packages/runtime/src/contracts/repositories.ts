import type { ChatId, RuntimeHostId, RuntimeId, WorkspaceId } from '@hq/kernel'
import type { HostLoad, Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

export type HostSecret = 'claimCode' | 'token'

export type RuntimeHostRepository = {
  add(host: RuntimeHost): Promise<void>
  get(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost>
  save(host: RuntimeHost): Promise<void>
  setSecretHash(host: RuntimeHost, secret: HostSecret, hash: string): Promise<void>
  findBySecretHash(secret: HostSecret, hash: string): Promise<{ host: RuntimeHost; claimed: boolean } | undefined>
  lockLoads(workspaceId: WorkspaceId): Promise<HostLoad[]>
}

export type RuntimeRepository = {
  lock(workspaceId: WorkspaceId, runtimeId: RuntimeId): Promise<Runtime>
  lockByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  lockOnHost(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<Runtime[]>
  lockSweepable(workspaceId: WorkspaceId): Promise<Runtime[]>
  findByChat(workspaceId: WorkspaceId, chatId: ChatId): Promise<Runtime | undefined>
  add(runtime: Runtime): Promise<void>
  save(runtime: Runtime): Promise<void>
  delete(runtime: Runtime): Promise<void>
  setHostOnline(workspaceId: WorkspaceId, hostId: RuntimeHostId, isOnline: boolean): Promise<void>
  agentConversationOf(runtime: Runtime): Promise<string | undefined>
  rememberAgentConversation(runtime: Runtime, conversationId: string): Promise<string>
  forgetAgentConversation(runtime: Runtime): Promise<void>
  chatOfLlmTokenHash(workspaceId: WorkspaceId, hostId: RuntimeHostId, hash: string): Promise<ChatId | undefined>
}

export type RuntimeSecret = 'apiKey' | 'llmTokenHash'
export type RuntimeSecrets = {
  keep(runtime: Runtime, secret: RuntimeSecret, value: string): Promise<void>
  valueOf(runtime: Runtime, secret: RuntimeSecret): Promise<string | undefined>
  discard(runtime: Runtime): Promise<void>
}

export type JobQueue = {
  enqueue(workspaceId: WorkspaceId, type: string, payload: object, delayMilliseconds?: number): Promise<void>
}
