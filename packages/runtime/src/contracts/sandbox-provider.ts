import type { HarnessId, RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { SetupSnapshotScope } from '../domain/warm-runtime.ts'

export type { SetupSnapshotScope }

export type SandboxLocation = { workspaceId: WorkspaceId; hostId: RuntimeHostId; runtimeId: string }
type HostLocation = Omit<SandboxLocation, 'runtimeId'>
export type SandboxStatus = 'running' | 'stopped' | 'missing'
export type PackageCacheScope = { repository: string; ownerId: string }
type CreateRequest = SandboxLocation & {
  image: string
  packageCache?: PackageCacheScope
  setupSnapshot?: SetupSnapshotScope
}
type SandboxRequest = {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
  timeoutMilliseconds?: number
}
export type SandboxResponse = { status: number; headers: Record<string, string>; body: string }
export type SandboxSocketListener = {
  onOpen(): void
  onMessage(data: string): void
  onClose(): void
}
type SandboxSocket = { send(data: string): void; close(): void }

export type SandboxTransport = {
  gatewayUrl: string
  fetch(request: SandboxRequest): Promise<SandboxResponse>
  openSocket(path: string, listener: SandboxSocketListener): SandboxSocket
}

export type SandboxProvider = {
  create(sandbox: CreateRequest): Promise<void>
  recreate(sandbox: CreateRequest): Promise<void>
  snapshot(sandbox: SandboxLocation & { setupSnapshot: SetupSnapshotScope }): Promise<void>
  pruneSnapshots(host: HostLocation & { keep: readonly SetupSnapshotScope[] }): Promise<void>
  currentApiKeyId: string
  apiKeyOf(sandbox: Pick<SandboxLocation, 'workspaceId' | 'runtimeId'> & { apiKeyId?: string }): string
  start(sandbox: SandboxLocation): Promise<void>
  stop(sandbox: SandboxLocation): Promise<void>
  remove(sandbox: SandboxLocation): Promise<void>
  status(sandbox: SandboxLocation): Promise<SandboxStatus>
  runtimeIdsOn(host: HostLocation): Promise<string[]>
  hasHarness(sandbox: SandboxLocation & { harness: HarnessId }): Promise<boolean>
  installHarness(sandbox: SandboxLocation & { harness: HarnessId }): Promise<void>
  connect(sandbox: SandboxLocation): SandboxTransport
}
