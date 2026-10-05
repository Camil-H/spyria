import type { MemberId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import { HostNotFound, NotWorkspaceAdmin } from './errors.ts'

export type HostSystem = {
  cpus: number
  memoryBytes: number
  dockerVersion: string
  rootless: boolean
  cgroupDriver: string
  limitsEnforced: boolean
}

export type HostCapacity = HostSystem & { cap: number; memoryFreeBytes?: number }

export type RuntimeHost = Readonly<{
  workspaceId: WorkspaceId
  id: RuntimeHostId
  name: string
  status: 'waiting' | 'online' | 'offline' | 'expired'
  claimExpiresAt: number | null
  capacity: HostCapacity | null
  runningRuntimes: number
  lastSeenAt: number | null
  createdBy: MemberId
  createdAt: number
  removedAt: number | null
}>

const gibibyte = 1024 ** 3
const reservedMemoryBytes = 2 * gibibyte

export const capacityOf = (system: HostSystem): HostCapacity => ({
  ...system,
  cap: Math.max(1, Math.floor((system.memoryBytes - reservedMemoryBytes) / gibibyte)),
})

export const assertNotRemoved = (host: RuntimeHost) => {
  if (host.removedAt !== null) throw new HostNotFound(host.id)
  return host
}

export const canRenewClaim = (host: RuntimeHost) => host.status === 'waiting' || host.status === 'expired'

export const assertAdmin = (role: 'admin' | 'member') => {
  if (role !== 'admin') throw new NotWorkspaceAdmin()
}

export const agentServerImage =
  'ghcr.io/openhands/agent-server@sha256:977a4791b90f46c0873f63d879180692802e47e7a0e760ab5add5d5a2505027d'
