import type { HarnessId, RuntimeHostId, WorkspaceId } from '@spyria/kernel'

export type SandboxLocation = { workspaceId: WorkspaceId; hostId: RuntimeHostId; runtimeId: string }
export type SandboxStatus = 'running' | 'stopped' | 'missing'
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
  create(sandbox: SandboxLocation & { image: string; apiKey: string }): Promise<void>
  start(sandbox: SandboxLocation): Promise<void>
  stop(sandbox: SandboxLocation): Promise<void>
  remove(sandbox: SandboxLocation): Promise<void>
  status(sandbox: SandboxLocation): Promise<SandboxStatus>
  hasHarness(sandbox: SandboxLocation & { harness: HarnessId }): Promise<boolean>
  installHarness(sandbox: SandboxLocation & { harness: HarnessId }): Promise<void>
  connect(sandbox: SandboxLocation): SandboxTransport
}
