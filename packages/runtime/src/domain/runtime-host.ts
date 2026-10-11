import type { MemberId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import { HostNotFound, NotWorkspaceAdmin, PairedAsMachine, PairedAsWorkspaceHost } from './errors.ts'

export type HostSystem = {
  cpus: number
  memoryBytes: number
  dockerVersion: string
  rootless: boolean
  cgroupDriver: string
  limitsEnforced: boolean
}

export type HostDeclaration = { personal: boolean; signedIn: string[] }
export type HostCapacity = HostSystem & Partial<HostDeclaration> & { cap: number; memoryFreeBytes?: number }

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
  ownerId: MemberId | null
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

export const assertCanManage = (host: RuntimeHost, memberId: MemberId, role: 'admin' | 'member') => {
  if (host.ownerId === null) assertAdmin(role)
  else if (host.ownerId !== memberId) throw new HostNotFound(host.id)
  return host
}

export const declarationRefusalOf = (host: RuntimeHost, personal: boolean) => {
  if (host.ownerId !== null && !personal) return new PairedAsMachine()
  if (host.ownerId === null && personal) return new PairedAsWorkspaceHost()
  return undefined
}

export const agentServerImage =
  'ghcr.io/openhands/agent-server@sha256:977a4791b90f46c0873f63d879180692802e47e7a0e760ab5add5d5a2505027d'
