import { type Docker, DockerError, hostMachineMapping, type Mount } from './docker.ts'
import {
  type HarnessId,
  harnessEnvironment,
  harnessesMountOf,
  harnessIds,
  installHarness,
  isHarnessInstalled,
} from './harnesses.ts'
import { credentialsMountsOf, ensureCredentialsReaders } from './personal.ts'

export class Refused extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`)
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/
const publishedAgentImageOf = (images: string) => `${images}/spyria-agent`
const isAcceptedImage = (image: string, images?: string) =>
  digestPattern.test(image) ||
  (images !== undefined &&
    image.startsWith(`${publishedAgentImageOf(images)}@`) &&
    digestPattern.test(image.slice(publishedAgentImageOf(images).length + 1)))
const imageRefusalOf = (images?: string) =>
  `image other than a local content ID (sha256:<64 hex>)${images ? ` or ${publishedAgentImageOf(images)}@sha256:<digest>` : ''}`
const isPublishedImage = (image: string) => image.includes('@')
const pullTimeoutMilliseconds = 10 * 60_000
const runtimeIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const apiKeyPattern = /^[A-Za-z0-9_-]{16,128}$/
const volumeKeyPattern = /^[a-f0-9]{32}$/
const packageCacheTarget = '/var/cache/spyria'
const snapshotTarget = '/var/lib/spyria/snapshot'
const snapshotTimeoutMilliseconds = 30 * 60_000
const maximumKeptSnapshots = 100
const spyriaAgentPort = 8000
export const gatewayRelayAlias = 'spyria-gateway-relay'
const gibibyte = 1024 ** 3
const volumeTargets = { ws: '/workspace', home: '/home/spyria', tmp: '/tmp' }
const operations = [
  'create',
  'recreate',
  'prepare',
  'start',
  'stop',
  'remove',
  'status',
  'installed',
  'install',
  'list',
  'snapshot',
  'prune_snapshots',
] as const

type Operation = (typeof operations)[number]
type HarnessOperation = 'installed' | 'install'
type CreateOperation = 'create' | 'recreate'
type RuntimeOperation = Exclude<
  Operation,
  CreateOperation | 'prepare' | 'list' | HarnessOperation | 'snapshot' | 'prune_snapshots'
>
type ContainerInfo = {
  Config?: { Labels?: Record<string, string>; Image?: string }
  State?: { Running?: boolean }
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
}
type CreateRequest = {
  runtimeId: string
  image: string
  apiKey: string
  packageCacheKey?: string
  snapshotKey?: string
}
export type Command =
  | ({ op: CreateOperation } & CreateRequest)
  | { op: 'prepare'; image: string }
  | { op: 'list' }
  | { op: RuntimeOperation; runtimeId: string }
  | { op: HarnessOperation; runtimeId: string; harness: HarnessId }
  | { op: 'snapshot'; runtimeId: string; snapshotKey: string }
  | { op: 'prune_snapshots'; keep: string[] }

const fieldOf = (fields: Record<string, unknown>, name: string, pattern: RegExp, reason: string) => {
  const value = fields[name]
  if (typeof value !== 'string' || !pattern.test(value)) throw new Refused(reason)
  return value
}

export const parseCommand = (op: unknown, args: unknown, images?: string): Command => {
  if (!operations.includes(op as Operation)) throw new Refused(`unknown command ${String(op)}`)
  const fields = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const allowedFields = {
    create: ['runtimeId', 'image', 'apiKey', 'packageCacheKey', 'snapshotKey'],
    recreate: ['runtimeId', 'image', 'apiKey', 'packageCacheKey', 'snapshotKey'],
    snapshot: ['runtimeId', 'snapshotKey'],
    prune_snapshots: ['keep'],
    prepare: ['image'],
    list: [],
    installed: ['runtimeId', 'harness'],
    install: ['runtimeId', 'harness'],
  }[op as string] ?? ['runtimeId']
  const extraFields = Object.keys(fields).filter((field) => !allowedFields.includes(field))
  if (extraFields.length > 0) throw new Refused(`unexpected fields ${extraFields.join(', ')}`)
  const imageOf = () => {
    const image = fields.image
    if (typeof image !== 'string' || !isAcceptedImage(image, images)) throw new Refused(imageRefusalOf(images))
    return image
  }
  if (op === 'prepare') return { op, image: imageOf() }
  if (op === 'list') return { op }
  if (op === 'prune_snapshots') {
    const { keep } = fields
    const isKeepList =
      Array.isArray(keep) &&
      keep.length <= maximumKeptSnapshots &&
      keep.every((key) => typeof key === 'string' && volumeKeyPattern.test(key))
    if (!isKeepList) throw new Refused('invalid snapshot keys')
    return { op, keep }
  }
  const volumeKeyOf = (name: string, reason: string) => fieldOf(fields, name, volumeKeyPattern, reason)
  const runtimeId = fieldOf(fields, 'runtimeId', runtimeIdPattern, 'invalid runtime id')
  if (op === 'installed' || op === 'install') {
    if (!harnessIds.includes(fields.harness as HarnessId)) throw new Refused('unknown harness')
    return { op, runtimeId, harness: fields.harness as HarnessId }
  }
  if (op === 'snapshot') return { op, runtimeId, snapshotKey: volumeKeyOf('snapshotKey', 'invalid snapshot key') }
  if (op !== 'create' && op !== 'recreate') return { op: op as RuntimeOperation, runtimeId }
  return {
    op,
    runtimeId,
    image: imageOf(),
    apiKey: fieldOf(fields, 'apiKey', apiKeyPattern, 'invalid API key'),
    ...(fields.packageCacheKey !== undefined && {
      packageCacheKey: volumeKeyOf('packageCacheKey', 'invalid package cache key'),
    }),
    ...(fields.snapshotKey !== undefined && { snapshotKey: volumeKeyOf('snapshotKey', 'invalid snapshot key') }),
  }
}

const containerNameOf = (prefix: string, runtimeId: string) => `${prefix}rt-${runtimeId}`
const networkNameOf = (prefix: string, runtimeId: string) => `${containerNameOf(prefix, runtimeId)}-net`
const packageCachePrefixOf = (prefix: string) => `${prefix}cache-`
const snapshotPrefixOf = (prefix: string, snapshotKey: string) => `${prefix}snapshot-${snapshotKey}-`
const snapshotLabel = 'spyria.snapshot'
const snapshotCopierOf = (runtimeContainer: string) => `${runtimeContainer}-snapshot`
const runtimeHardening = {
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
}

export const containerBodyOf = ({
  prefix,
  runtimeId,
  image,
  apiKey,
  packageCacheKey,
  snapshotVolume,
  personal = false,
}: Omit<CreateRequest, 'snapshotKey'> & { prefix: string; snapshotVolume?: string; personal?: boolean }) => {
  const name = containerNameOf(prefix, runtimeId)
  return {
    Image: image,
    Hostname: name,
    User: '10001:10001',
    Env: [
      `OH_SESSION_API_KEYS_0=${apiKey}`,
      ...(personal ? harnessEnvironment : []),
      ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? [`OTEL_EXPORTER_OTLP_ENDPOINT=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`]
        : []),
    ],
    Labels: { 'spyria.managed': '1', 'spyria.runtime': runtimeId },
    HostConfig: {
      Init: true,
      NetworkMode: networkNameOf(prefix, runtimeId),
      ExtraHosts: [hostMachineMapping],
      ...runtimeHardening,
      Mounts: [
        ...Object.entries(volumeTargets).map(
          ([suffix, target]): Mount => ({
            Type: 'volume',
            Source: `${name}-${suffix}`,
            Target: target,
          }),
        ),
        ...(packageCacheKey
          ? [
              {
                Type: 'volume',
                Source: `${packageCachePrefixOf(prefix)}${packageCacheKey}`,
                Target: packageCacheTarget,
              } as const,
            ]
          : []),
        ...(snapshotVolume
          ? [{ Type: 'volume', Source: snapshotVolume, Target: snapshotTarget, ReadOnly: true } as const]
          : []),
        ...(personal ? [...credentialsMountsOf(prefix), harnessesMountOf(prefix)] : []),
      ],
    },
  }
}

export const snapshotCopyBodyOf = ({
  prefix,
  runtimeId,
  image,
  snapshotVolume,
}: {
  prefix: string
  runtimeId: string
  image: string
  snapshotVolume: string
}) => {
  const runtime = containerNameOf(prefix, runtimeId)
  return {
    Image: image,
    User: '10001:10001',
    Entrypoint: [
      'sh',
      '-c',
      `cp -a ${volumeTargets.ws}/project ${snapshotTarget}/project && cp -a ${volumeTargets.home} ${snapshotTarget}/home && touch ${snapshotTarget}/complete`,
    ],
    Labels: { 'spyria.managed': '1' },
    HostConfig: {
      ...runtimeHardening,
      NetworkMode: 'none',
      Mounts: [
        { Type: 'volume', Source: `${runtime}-ws`, Target: volumeTargets.ws, ReadOnly: true },
        { Type: 'volume', Source: `${runtime}-home`, Target: volumeTargets.home, ReadOnly: true },
        { Type: 'volume', Source: snapshotVolume, Target: snapshotTarget },
      ] satisfies Mount[],
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
    if (labels['spyria.managed'] !== '1' || labels['spyria.runtime'] !== runtimeId)
      throw new Refused('not a managed runtime')
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
    await docker('POST', '/networks/create', {
      Name: network,
      Driver: 'bridge',
      Labels: { 'spyria.managed': '1' },
    }).catch(ignoring(409))
    await joinNetwork(network)
  }
  const removeNetwork = async (network: string) => {
    if (selfContainerId)
      await docker('POST', `/networks/${network}/disconnect`, { Container: selfContainerId, Force: true }).catch(
        ignoring(403, 404),
      )
    await docker('DELETE', `/networks/${network}`).catch(ignoringMissing)
  }
  const pull = async (image: string) => {
    const [name = '', digest = ''] = image.split('@')
    const progress = await docker<string>(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${digest}`,
      undefined,
      pullTimeoutMilliseconds,
    )
    const failure = progress
      .split('\n')
      .flatMap((line): { error?: string }[] => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      .find((event) => event.error)
    if (failure) throw new Error(`Pulling Spyria's runtime image failed: ${failure.error}`)
  }
  const prepare = async (image: string) => {
    const isPresent = await docker('GET', `/images/${image}/json`).then(
      () => true,
      (error) => {
        ignoringMissing(error)
        return false
      },
    )
    if (!isPresent && !isPublishedImage(image))
      throw new Error("Spyria's runtime image is missing on this machine: run bun run agent:build")
    if (!isPresent) await pull(image)
    if (personal) await ensureCredentialsReaders(docker, prefix, image)
  }
  const runtimeIdsOf = async (includingStopped: boolean) => {
    const filters = encodeURIComponent(JSON.stringify({ label: ['spyria.managed=1', 'spyria.runtime'] }))
    const containers = await docker<{ Names: string[]; Labels: Record<string, string> }[]>(
      'GET',
      `/containers/json?all=${includingStopped}&filters=${filters}`,
    )
    return containers
      .map(({ Names, Labels }) => ({ Names, runtimeId: Labels['spyria.runtime'] ?? '' }))
      .filter(({ Names, runtimeId }) => Names.includes(`/${containerNameOf(prefix, runtimeId)}`))
      .map(({ runtimeId }) => runtimeId)
  }
  const removeUnusedPackageCaches = async () => {
    const cachePrefix = packageCachePrefixOf(prefix)
    const filters = encodeURIComponent(JSON.stringify({ name: [cachePrefix], dangling: ['true'] }))
    const { Volumes } = await docker<{ Volumes: { Name: string }[] | null }>('GET', `/volumes?filters=${filters}`)
    for (const { Name } of Volumes ?? [])
      if (Name.startsWith(cachePrefix) && volumeKeyPattern.test(Name.slice(cachePrefix.length)))
        await docker('DELETE', `/volumes/${Name}`).catch(ignoring(404, 409))
  }
  const snapshotVolumesOf = async (snapshotKey?: string) => {
    const label = snapshotKey ? `${snapshotLabel}=${snapshotKey}` : snapshotLabel
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }))
    const { Volumes } = await docker<{ Volumes: { Name: string; Labels: Record<string, string> | null }[] | null }>(
      'GET',
      `/volumes?filters=${filters}`,
    )
    return (Volumes ?? [])
      .map(({ Name, Labels }) => ({ name: Name, snapshotKey: Labels?.[snapshotLabel] ?? '' }))
      .filter(
        ({ name, snapshotKey }) =>
          volumeKeyPattern.test(snapshotKey) && name.startsWith(snapshotPrefixOf(prefix, snapshotKey)),
      )
      .toSorted((first, second) => second.name.localeCompare(first.name))
  }
  const removeSnapshots = async (isRemoved: (snapshotKey: string, isNewest: boolean) => boolean) => {
    const keysSeen = new Set<string>()
    for (const volume of await snapshotVolumesOf()) {
      const isNewest = !keysSeen.has(volume.snapshotKey)
      keysSeen.add(volume.snapshotKey)
      if (isRemoved(volume.snapshotKey, isNewest))
        await docker('DELETE', `/volumes/${volume.name}`).catch(ignoring(404, 409))
    }
  }
  const copiedWhilePaused = async (runtime: string, copier: string) => {
    await docker('POST', `/containers/${runtime}/pause`)
    try {
      await docker('POST', `/containers/${copier}/start`)
      return (
        await docker<{ StatusCode: number }>(
          'POST',
          `/containers/${copier}/wait`,
          undefined,
          snapshotTimeoutMilliseconds,
        )
      ).StatusCode
    } finally {
      await docker('POST', `/containers/${runtime}/unpause`).catch(ignoring(409))
    }
  }
  const snapshot = async (runtimeId: string, snapshotKey: string) => {
    if (personal) throw new Refused('snapshots are taken only on a workspace host')
    const runtime = containerNameOf(prefix, runtimeId)
    const image = (await managedContainer(runtimeId)).Config?.Image ?? ''
    const snapshotVolume = `${snapshotPrefixOf(prefix, snapshotKey)}${Date.now().toString(36).padStart(9, '0')}`
    await docker('POST', '/volumes/create', {
      Name: snapshotVolume,
      Labels: { 'spyria.managed': '1', [snapshotLabel]: snapshotKey },
    })
    const copier = snapshotCopierOf(runtime)
    await docker('DELETE', `/containers/${copier}?force=true`).catch(ignoringMissing)
    await docker(
      'POST',
      `/containers/create?name=${copier}`,
      snapshotCopyBodyOf({ prefix, runtimeId, image, snapshotVolume }),
    )
    const exitCode = await copiedWhilePaused(runtime, copier).catch((error: Error) => error)
    await docker('DELETE', `/containers/${copier}?force=true`).catch(ignoringMissing)
    if (exitCode !== 0) {
      await docker('DELETE', `/volumes/${snapshotVolume}`).catch(ignoring(404, 409))
      throw exitCode instanceof Error ? exitCode : new Error(`Copying the snapshot failed with exit code ${exitCode}`)
    }
    await removeSnapshots((key, isNewest) => key === snapshotKey && !isNewest)
  }
  const create = async ({ snapshotKey, ...request }: CreateRequest) => {
    await Promise.all([createNetwork(networkNameOf(prefix, request.runtimeId)), prepare(request.image)])
    const [newestSnapshot] = snapshotKey && !personal ? await snapshotVolumesOf(snapshotKey) : []
    await docker(
      'POST',
      `/containers/create?name=${containerNameOf(prefix, request.runtimeId)}`,
      containerBodyOf({ prefix, ...request, snapshotVolume: newestSnapshot?.name, personal }),
    )
  }
  const run = async (command: Command) => {
    if (command.op === 'prepare') return void (await prepare(command.image))
    if (command.op === 'list') return runtimeIdsOf(true)
    if (command.op === 'prune_snapshots') {
      if (personal) throw new Refused('snapshots are taken only on a workspace host')
      return removeSnapshots((key, isNewest) => !command.keep.includes(key) || !isNewest)
    }
    if (command.op === 'snapshot') return snapshot(command.runtimeId, command.snapshotKey)
    const name = containerNameOf(prefix, command.runtimeId)
    if (command.op === 'create') return create(command)
    if (command.op === 'recreate') {
      const replaced = await managedContainer(command.runtimeId).catch(ignoringMissing)
      if (replaced) await docker('DELETE', `/containers/${name}?force=true`)
      return create(command)
    }
    if (command.op === 'installed' || command.op === 'install') {
      if (!personal) throw new Refused('harnesses install only on a personal host')
      if (command.op === 'installed') return isHarnessInstalled(docker, name, command.harness)
      const image = (await managedContainer(command.runtimeId)).Config?.Image ?? ''
      return installHarness(docker, prefix, image, command.harness)
    }
    if (command.op === 'status')
      return managedContainer(command.runtimeId).then(
        (container) => (container.State?.Running ? 'running' : 'stopped'),
        (error) => {
          ignoringMissing(error)
          return 'missing'
        },
      )
    const network = networkNameOf(prefix, command.runtimeId)
    if (command.op === 'start') {
      await managedContainer(command.runtimeId)
      await createNetwork(network)
      await docker('POST', `/networks/${network}/connect`, { Container: name })
      return docker('POST', `/containers/${name}/start`)
    }
    const container = await managedContainer(command.runtimeId).catch(ignoringMissing)
    if (command.op === 'stop') {
      if (container) await docker('POST', `/containers/${name}/stop?t=10`)
      return removeNetwork(network)
    }
    if (container) await docker('DELETE', `/containers/${name}?force=true`)
    await docker('DELETE', `/containers/${snapshotCopierOf(name)}?force=true`).catch(ignoringMissing)
    for (const suffix of Object.keys(volumeTargets))
      await docker('DELETE', `/volumes/${name}-${suffix}`).catch(ignoringMissing)
    await removeNetwork(network)
    await removeUnusedPackageCaches()
  }
  return {
    run,
    originOf: async (runtimeId: string) => {
      const networks = Object.values((await managedContainer(runtimeId)).NetworkSettings?.Networks ?? {})
      const address = networks.find((network) => network.IPAddress)?.IPAddress
      if (!address) throw new Refused('runtime is not running')
      return `http://${address}:${spyriaAgentPort}`
    },
    runningCount: async () => (await runtimeIdsOf(false)).length,
  }
}
