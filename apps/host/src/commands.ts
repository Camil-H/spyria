import { type Docker, DockerError } from './docker.ts'
import { credentialsMountsOf, ensureCredentialsReaders } from './personal.ts'

export class Refused extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`)
  }
}

const imagePattern = /^sha256:[a-f0-9]{64}$/
const runtimeIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const apiKeyPattern = /^[A-Za-z0-9_-]{16,128}$/
const spyriaAgentPort = 8000
export const gatewayRelayAlias = 'hq-gateway-relay'
const gibibyte = 1024 ** 3
const volumeTargets = { ws: '/workspace', home: '/home/openhands', tmp: '/tmp' }
const operations = ['create', 'prepare', 'start', 'stop', 'remove', 'status'] as const
const imageRefusal = 'image other than a local content ID (sha256:<64 hex>)'

type Operation = (typeof operations)[number]
type RuntimeOperation = Exclude<Operation, 'create' | 'prepare'>
type ContainerInfo = {
  Config?: { Labels?: Record<string, string> }
  State?: { Running?: boolean }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}
type CreateRequest = { runtimeId: string; image: string; apiKey: string }
export type Command =
  | ({ op: 'create' } & CreateRequest)
  | { op: 'prepare'; image: string }
  | { op: RuntimeOperation; runtimeId: string }

const fieldOf = (fields: Record<string, unknown>, name: string, pattern: RegExp, reason: string) => {
  const value = fields[name]
  if (typeof value !== 'string' || !pattern.test(value)) throw new Refused(reason)
  return value
}

export const parseCommand = (op: unknown, args: unknown): Command => {
  if (!operations.includes(op as Operation)) throw new Refused(`unknown command ${String(op)}`)
  const fields = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const allowedFields = { create: ['runtimeId', 'image', 'apiKey'], prepare: ['image'] }[op as string] ?? ['runtimeId']
  const extraFields = Object.keys(fields).filter((field) => !allowedFields.includes(field))
  if (extraFields.length > 0) throw new Refused(`unexpected fields ${extraFields.join(', ')}`)
  const imageOf = () => fieldOf(fields, 'image', imagePattern, imageRefusal)
  if (op === 'prepare') return { op, image: imageOf() }
  const runtimeId = fieldOf(fields, 'runtimeId', runtimeIdPattern, 'invalid runtime id')
  if (op !== 'create') return { op: op as RuntimeOperation, runtimeId }
  return {
    op,
    runtimeId,
    image: imageOf(),
    apiKey: fieldOf(fields, 'apiKey', apiKeyPattern, 'invalid API key'),
  }
}

const containerNameOf = (prefix: string, runtimeId: string) => `${prefix}rt-${runtimeId}`
const networkNameOf = (prefix: string, runtimeId: string) => `${containerNameOf(prefix, runtimeId)}-net`

export const containerBodyOf = ({
  prefix,
  runtimeId,
  image,
  apiKey,
  personal = false,
}: CreateRequest & { prefix: string; personal?: boolean }) => {
  const name = containerNameOf(prefix, runtimeId)
  return {
    Image: image,
    Hostname: name,
    User: '10001:10001',
    Env: [`OH_SESSION_API_KEYS_0=${apiKey}`],
    Labels: { 'hq.managed': '1', 'hq.runtime': runtimeId },
    HostConfig: {
      NetworkMode: networkNameOf(prefix, runtimeId),
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Privileged: false,
      PublishAllPorts: false,
      Memory: 2 * gibibyte,
      MemorySwap: 2 * gibibyte,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
      Mounts: [
        ...Object.entries(volumeTargets).map(([suffix, target]) => ({
          Type: 'volume',
          Source: `${name}-${suffix}`,
          Target: target,
        })),
        ...(personal ? credentialsMountsOf(prefix) : []),
      ],
    },
  }
}

export const relayUrlOf = (origin: string, path: string) => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Refused('invalid relay path')
  const url = new URL(path, origin)
  if (url.origin !== new URL(origin).origin) throw new Refused('invalid relay path')
  return url
}

const ignoring =
  (...statuses: number[]) =>
  (error: unknown) => {
    if (!(error instanceof DockerError) || !statuses.includes(error.status)) throw error
  }
const ignoringMissing = ignoring(404)

export const createCommandRunner = ({
  docker,
  prefix,
  selfContainerId,
  personal = false,
}: {
  docker: Docker
  prefix: string
  selfContainerId?: string
  personal?: boolean
}) => {
  const managedContainer = async (runtimeId: string) => {
    const container = await docker<ContainerInfo>('GET', `/containers/${containerNameOf(prefix, runtimeId)}/json`)
    const labels = container.Config?.Labels ?? {}
    if (labels['hq.managed'] !== '1' || labels['hq.runtime'] !== runtimeId) throw new Refused('not a managed runtime')
    return container
  }
  const joinNetwork = async (network: string) => {
    if (selfContainerId)
      await docker('POST', `/networks/${network}/connect`, {
        Container: selfContainerId,
        EndpointConfig: { Aliases: [gatewayRelayAlias] },
      }).catch(ignoring(403, 409))
  }
  const createNetwork = async (network: string) => {
    await docker('POST', '/networks/create', { Name: network, Driver: 'bridge', Labels: { 'hq.managed': '1' } }).catch(
      ignoring(409),
    )
    await joinNetwork(network)
  }
  const removeNetwork = async (network: string) => {
    if (selfContainerId)
      await docker('POST', `/networks/${network}/disconnect`, { Container: selfContainerId, Force: true }).catch(
        ignoring(403, 404),
      )
    await docker('DELETE', `/networks/${network}`).catch(ignoringMissing)
  }
  const prepare = async (image: string) => {
    await docker('GET', `/images/${image}/json`).catch((error) => {
      ignoringMissing(error)
      throw new Error("Spyria's runtime image is missing on this machine: run bun run agent:build")
    })
    if (personal) await ensureCredentialsReaders(docker, prefix, image)
  }
  const create = async ({ runtimeId, image, apiKey }: CreateRequest) => {
    await Promise.all([createNetwork(networkNameOf(prefix, runtimeId)), prepare(image)])
    await docker(
      'POST',
      `/containers/create?name=${containerNameOf(prefix, runtimeId)}`,
      containerBodyOf({ prefix, runtimeId, image, apiKey, personal }),
    )
  }
  const run = async (command: Command) => {
    if (command.op === 'prepare') return void (await prepare(command.image))
    const name = containerNameOf(prefix, command.runtimeId)
    if (command.op === 'create') return create(command)
    if (command.op === 'status')
      return managedContainer(command.runtimeId).then(
        (container) => (container.State?.Running ? 'running' : 'stopped'),
        (error) => {
          ignoringMissing(error)
          return 'missing'
        },
      )
    const container = await managedContainer(command.runtimeId)
    if (command.op === 'start') {
      for (const network of Object.keys(container.NetworkSettings?.Networks ?? {})) await joinNetwork(network)
      return docker('POST', `/containers/${name}/start`)
    }
    if (command.op === 'stop') return docker('POST', `/containers/${name}/stop?t=10`)
    await docker('DELETE', `/containers/${name}?force=true`)
    for (const suffix of Object.keys(volumeTargets))
      await docker('DELETE', `/volumes/${name}-${suffix}`).catch(ignoringMissing)
    await removeNetwork(networkNameOf(prefix, command.runtimeId))
  }
  return {
    run,
    originOf: async (runtimeId: string) => {
      const networks = Object.values((await managedContainer(runtimeId)).NetworkSettings?.Networks ?? {})
      const address = networks.find((network) => network.IPAddress)?.IPAddress
      if (!address) throw new Refused('runtime is not running')
      return `http://${address}:${spyriaAgentPort}`
    },
    runningCount: async () => {
      const filters = encodeURIComponent(JSON.stringify({ label: ['hq.managed=1'] }))
      const containers = await docker<{ Names: string[] }[]>('GET', `/containers/json?filters=${filters}`)
      return containers.filter((container) => container.Names.some((name) => name.startsWith(`/${prefix}rt-`))).length
    },
  }
}
