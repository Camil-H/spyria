import {
  type MemberId,
  type RuntimeHostId,
  requirePermissionIn,
  type WorkspaceId,
  type WorkspacePermission,
} from '@spyria/kernel'
import { HostNotFound, PairedAsMachine, PairedAsWorkspaceHost } from './errors.ts'

export type HostSystem = {
  cpus: number
  memoryBytes: number
  dockerVersion: string
  rootless: boolean
  cgroupDriver: string
  limitsEnforced: boolean
}

export type HostDeclaration = { personal: boolean; signedIn: string[]; credentialsChangedAt?: Record<string, number> }
type HostCapacity = HostSystem &
  Partial<HostDeclaration> & { cap: number; memoryFreeBytes?: number; expiredSignIns?: Record<string, number> }

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

export const canRenewClaim = (host: RuntimeHost) =>
  host.status === 'waiting' || host.status === 'expired' || (host.ownerId !== null && host.status === 'offline')

export const assertCanManage = (host: RuntimeHost, memberId: MemberId, permissions: readonly WorkspacePermission[]) => {
  if (host.ownerId === null) requirePermissionIn(permissions, 'runtimes.manage')
  else if (host.ownerId !== memberId) throw new HostNotFound(host.id)
  return host
}

export const declarationRefusalOf = (host: RuntimeHost, personal: boolean) => {
  if (host.ownerId !== null && !personal) return new PairedAsMachine()
  if (host.ownerId === null && personal) return new PairedAsWorkspaceHost()
  return undefined
}

export const signInsOf = (
  { signedIn = [], credentialsChangedAt = {} }: Partial<HostDeclaration>,
  expired: Record<string, number> = {},
) => {
  const expiredSignIns = Object.fromEntries(
    Object.entries(expired).filter(([tool, changedAt]) => credentialsChangedAt[tool] === changedAt),
  )
  return { signedIn: signedIn.filter((tool) => !(tool in expiredSignIns)), credentialsChangedAt, expiredSignIns }
}

export const withExpiredSignIn = (capacity: HostCapacity, tool: string): HostCapacity => ({
  ...capacity,
  signedIn: capacity.signedIn?.filter((signedInTool) => signedInTool !== tool),
  expiredSignIns: { ...capacity.expiredSignIns, [tool]: capacity.credentialsChangedAt?.[tool] ?? 0 },
})
