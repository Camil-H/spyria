import { type Docker, DockerError } from './docker.ts'

export class Refused extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`)
  }
}

const imagePattern = /^ghcr\.io\/openhands\/agent-server@sha256:[a-f0-9]{64}$/
const runtimeIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const apiKeyPattern = /^[A-Za-z0-9_-]{16,128}$/
const agentServerPort = 8000
export const gatewayRelayAlias = 'hq-gateway-relay'
const gibibyte = 1024 ** 3
const volumeTargets = { ws: '/workspace', home: '/home/openhands', tmp: '/tmp' }
const operations = ['create', 'prepare', 'start', 'stop', 'remove', 'status'] as const
const imageRefusal = 'image outside ghcr.io/openhands/agent-server@sha256'

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
  if (op === 'prepare') return { op, image: fieldOf(fields, 'image', imagePattern, imageRefusal) }
  const runtimeId = fieldOf(fields, 'runtimeId', runtimeIdPattern, 'invalid runtime id')
  if (op !== 'create') return { op: op as RuntimeOperation, runtimeId }
  return {
    op,
    runtimeId,
    image: fieldOf(fields, 'image', imagePattern, imageRefusal),
    apiKey: fieldOf(fields, 'apiKey', apiKeyPattern, 'invalid API key'),
  }
}

const containerNameOf = (prefix: string, runtimeId: string) => `${prefix}rt-${runtimeId}`

export const containerBodyOf = ({ prefix, runtimeId, image, apiKey }: CreateRequest & { prefix: string }) => {
  const name = containerNameOf(prefix, runtimeId)
  return {
    Image: image,
    Hostname: name,
    User: '10001:10001',
    Env: [
      `OH_SESSION_API_KEYS_0=${apiKey}`,
      'OH_ENABLE_VSCODE=false',
      'OH_ENABLE_BROWSER=false',
      'OH_PRELOAD_TOOLS=false',
      'OPENHANDS_SUPPRESS_BANNER=1',
    ],
    Labels: { 'hq.managed': '1', 'hq.runtime': runtimeId },
    HostConfig: {
      NetworkMode: `${prefix}runtimes`,
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
      Mounts: Object.entries(volumeTargets).map(([suffix, target]) => ({
        Type: 'volume',
        Source: `${name}-${suffix}`,
        Target: target,
      })),
    },
  }
}

export const relayUrlOf = (origin: string, path: string) => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Refused('invalid relay path')
  const url = new URL(path, origin)
  if (url.origin !== new URL(origin).origin) throw new Refused('invalid relay path')
  return url
}

const ignoringMissing = (error: unknown) => {
  if (!(error instanceof DockerError) || error.status !== 404) throw error
}

export const createCommandRunner = ({
  docker,
  prefix,
  selfContainerId,
}: {
  docker: Docker
  prefix: string
  selfContainerId?: string
}) => {
  const network = `${prefix}runtimes`
  const managedContainer = async (runtimeId: string) => {
    const container = await docker<ContainerInfo>('GET', `/containers/${containerNameOf(prefix, runtimeId)}/json`)
    const labels = container.Config?.Labels ?? {}
    if (labels['hq.managed'] !== '1' || labels['hq.runtime'] !== runtimeId) throw new Refused('not a managed runtime')
    return container
  }
  const ensureNetwork = async () => {
    await docker('GET', `/networks/${network}`).catch(async (error) => {
      ignoringMissing(error)
      await docker('POST', '/networks/create', {
        Name: network,
        Driver: 'bridge',
        Labels: { 'hq.managed': '1' },
      }).catch((createError) => {
        if (!(createError instanceof DockerError) || createError.status !== 409) throw createError
      })
    })
    if (selfContainerId)
      await docker('POST', `/networks/${network}/connect`, {
        Container: selfContainerId,
        EndpointConfig: { Aliases: [gatewayRelayAlias] },
      }).catch((error) => {
        if (!(error instanceof DockerError) || ![403, 409].includes(error.status)) throw error
      })
  }
  const prepare = (image: string) =>
    docker('GET', `/images/${image}/json`).catch(async (error) => {
      ignoringMissing(error)
      const [repository, digest] = image.split('@')
      await docker('POST', `/images/create?fromImage=${repository}&tag=${digest}`)
    })
  const create = async ({ runtimeId, image, apiKey }: CreateRequest) => {
    await Promise.all([ensureNetwork(), prepare(image)])
    await docker(
      'POST',
      `/containers/create?name=${containerNameOf(prefix, runtimeId)}`,
      containerBodyOf({ prefix, runtimeId, image, apiKey }),
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
    await managedContainer(command.runtimeId)
    if (command.op === 'start') return docker('POST', `/containers/${name}/start`)
    if (command.op === 'stop') return docker('POST', `/containers/${name}/stop?t=10`)
    await docker('DELETE', `/containers/${name}?force=true`)
    for (const suffix of Object.keys(volumeTargets))
      await docker('DELETE', `/volumes/${name}-${suffix}`).catch(ignoringMissing)
  }
  return {
    run,
    originOf: async (runtimeId: string) => {
      const address = (await managedContainer(runtimeId)).NetworkSettings?.Networks?.[network]?.IPAddress
      if (!address) throw new Refused('runtime is not running')
      return `http://${address}:${agentServerPort}`
    },
    runningCount: async () => {
      const filters = encodeURIComponent(JSON.stringify({ label: ['hq.managed=1'] }))
      const containers = await docker<{ Names: string[] }[]>('GET', `/containers/json?filters=${filters}`)
      return containers.filter((container) => container.Names.some((name) => name.startsWith(`/${prefix}rt-`))).length
    },
  }
}
