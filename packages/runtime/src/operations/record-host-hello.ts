import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { hashSecret } from '../domain/claim.ts'
import { HostNotRegistered, HostOutOfDate, type HostRefused, HostRemoved } from '../domain/errors.ts'
import { isHostOutOfDate } from '../domain/host-version.ts'
import { runtimeJobTypes } from '../domain/runtime.ts'
import {
  capacityOf,
  declarationRefusalOf,
  type HostDeclaration,
  type HostSystem,
  type RuntimeHost,
  signInsOf,
} from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type ConnectedHost = { workspaceId: WorkspaceId; hostId: RuntimeHostId }
type Input = Partial<HostDeclaration> & {
  token: string
  system: HostSystem
  hostVersion?: string
  protocolVersion?: number
  now: number
  beforeOnline?: (host: ConnectedHost) => void
  updateCommandOf?: (host: RuntimeHost) => string
}

export const recordHostHello = async (
  { transactor }: Dependencies,
  {
    token,
    system,
    personal = false,
    signedIn,
    credentialsChangedAt,
    hostVersion,
    protocolVersion = 0,
    now,
    beforeOnline,
    updateCommandOf = () => 'the command in Workspace settings',
  }: Input,
) => {
  const tokenHash = await hashSecret(token)
  return transactor.run(async ({ runtimeHosts, runtimes, jobs }): Promise<ConnectedHost | { refusal: HostRefused }> => {
    const host = (await runtimeHosts.findBySecretHash('token', tokenHash))?.host
    if (!host) throw new HostNotRegistered()
    if (host.removedAt !== null) throw new HostRemoved()
    if (isHostOutOfDate(protocolVersion)) {
      await runtimeHosts.save({ ...host, hostVersion: hostVersion ?? null, protocolVersion })
      return { refusal: new HostOutOfDate(updateCommandOf(host)) }
    }
    const refusal = declarationRefusalOf(host, personal)
    if (refusal) throw refusal
    const connected = { workspaceId: host.workspaceId, hostId: host.id }
    beforeOnline?.(connected)
    await runtimeHosts.save({
      ...host,
      status: 'online',
      hostVersion: hostVersion ?? null,
      protocolVersion,
      capacity: {
        ...capacityOf(system),
        ...(personal && { personal, ...signInsOf({ signedIn, credentialsChangedAt }, host.capacity?.expiredSignIns) }),
      },
      lastSeenAt: now,
    })
    await runtimes.setHostOnline(host.workspaceId, host.id, true)
    if (!personal) await jobs.enqueue(host.workspaceId, runtimeJobTypes.warm, {})
    return connected
  })
}
