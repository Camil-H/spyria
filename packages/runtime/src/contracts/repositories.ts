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
}

export type RuntimeApiKeys = {
  keep(runtime: Runtime, apiKey: string): Promise<void>
  keyOf(runtime: Runtime): Promise<string | undefined>
  discard(runtime: Runtime): Promise<void>
}

export type JobQueue = {
  enqueue(workspaceId: WorkspaceId, type: string, payload: object, delayMilliseconds?: number): Promise<void>
}
