import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeHost } from '../domain/runtime-host.ts'

export type HostSecret = 'claimCode' | 'token'

export type RuntimeHostRepository = {
  add(host: RuntimeHost): Promise<void>
  get(workspaceId: WorkspaceId, hostId: RuntimeHostId): Promise<RuntimeHost>
  save(host: RuntimeHost): Promise<void>
  setSecretHash(host: RuntimeHost, secret: HostSecret, hash: string): Promise<void>
  findBySecretHash(secret: HostSecret, hash: string): Promise<{ host: RuntimeHost; claimed: boolean } | undefined>
}
