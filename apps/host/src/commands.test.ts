import { expect, test } from 'bun:test'
import { type Command, containerBodyOf, createCommandRunner, parseCommand, relayUrlOf } from './commands.ts'
import { type Docker, DockerError } from './docker.ts'
import { harnessEnvironment } from './harnesses.ts'

const image = `sha256:${'a'.repeat(64)}`
const apiKey = 'k'.repeat(32)
const create = { runtimeId: 'runtime-1', image, apiKey }

test('accepts exactly create, prepare, start, stop, remove, status, installed, install and list with their arguments', () => {
  expect(parseCommand('create', create)).toEqual({ op: 'create', ...create })
  for (const op of ['installed', 'install'] as const)
    expect(parseCommand(op, { runtimeId: 'runtime-1', harness: 'codex' })).toEqual({
      op,
      runtimeId: 'runtime-1',
      harness: 'codex',
    })
  expect(parseCommand('prepare', { image })).toEqual({ op: 'prepare', image })
  expect(parseCommand('list', {})).toEqual({ op: 'list' })
  expect(() => parseCommand('list', { runtimeId: 'runtime-1' })).toThrow('unexpected fields runtimeId')
  for (const op of ['start', 'stop', 'remove', 'status'] as const)
    expect(parseCommand(op, { runtimeId: 'runtime-1' })).toEqual({ op, runtimeId: 'runtime-1' })
})

test.each(['exec', 'pull', 'inspect', 'run', 'logs', 'build', 'kill', '__proto__', 'constructor', 42, undefined])(
  'refuses the command %p',
  (op) => {
    expect(() => parseCommand(op, { runtimeId: 'runtime-1' })).toThrow('refused')
  },
)

test.each([
  'ghcr.io/openhands/agent-server@sha256:977a4791b90f46c0873f63d879180692802e47e7a0e760ab5add5d5a2505027d',
  'docker.io/library/alpine:3',
  'ghcr.io/openhands/agent-server:1.51.0-python',
  `ghcr.io/evil/agent-server@sha256:${'a'.repeat(64)}`,
  `sha256:${'b'.repeat(63)}`,
  `sha256:${'A'.repeat(64)}`,
  `sha256:${'a'.repeat(64)} --privileged`,
  `evil.io/sha256:${'a'.repeat(64)}`,
])('both host kinds refuse the image %p and name the local content ID they accept', (refusedImage) => {
  expect(() => parseCommand('create', { ...create, image: refusedImage })).toThrow('local content ID')
  expect(() => parseCommand('prepare', { image: refusedImage })).toThrow('local content ID')
})

const contentId = `sha256:${'b'.repeat(64)}`

const packageCacheKey = 'c'.repeat(32)

test('a create with a package cache key mounts that cache volume at the package cache directory; without one, no cache is mounted', () => {
  expect(parseCommand('create', { ...create, packageCacheKey })).toEqual({ op: 'create', ...create, packageCacheKey })
  const mountsOf = (body: ReturnType<typeof containerBodyOf>) =>
    body.HostConfig.Mounts.map(({ Source, Target }) => [Source, Target])
  expect(mountsOf(containerBodyOf({ prefix: 'spyria-', ...create, packageCacheKey }))).toContainEqual([
    `spyria-cache-${packageCacheKey}`,
    '/var/cache/spyria',
  ])
  expect(mountsOf(containerBodyOf({ prefix: 'spyria-', ...create })).map(([, target]) => target)).not.toContain(
    '/var/cache/spyria',
  )
})

test.each(['../spyria-host', packageCacheKey.toUpperCase(), `${packageCacheKey}0`, 'short', 42])(
  'refuses the package cache key %p',
  (refusedKey) => {
    expect(() => parseCommand('create', { ...create, packageCacheKey: refusedKey })).toThrow('refused')
  },
)

test('a workspace create sets only the session key in the environment, a personal one adds the harness paths', () => {
  expect(containerBodyOf({ prefix: 'spyria-', ...create }).Env).toEqual([`OH_SESSION_API_KEYS_0=${apiKey}`])
  expect(containerBodyOf({ prefix: 'spyria-', ...create, personal: true }).Env).toEqual([
    `OH_SESSION_API_KEYS_0=${apiKey}`,
    ...harnessEnvironment,
  ])
})

test.each([
  ['an unknown harness', { runtimeId: 'runtime-1', harness: 'pi' }],
  ['no harness', { runtimeId: 'runtime-1' }],
  ['an image', { runtimeId: 'runtime-1', harness: 'codex', image }],
  ['a registry', { runtimeId: 'runtime-1', harness: 'codex', registry: 'https://evil.example' }],
])('refuses an install with %s', (_, fields) => {
  expect(() => parseCommand('install', fields)).toThrow('refused')
})

test('a workspace host refuses to check or install a harness', async () => {
  const runner = createCommandRunner({ docker: (async () => ({})) as Docker, prefix: 'spyria-' })
  for (const op of ['installed', 'install'] as const)
    await expect(runner.run({ op, runtimeId: 'runtime-1', harness: 'claude-code' })).rejects.toThrow('refused')
})

test.each([true, false])(
  'preparing a content ID never pulls (personal %p): a missing image is an error naming the build',
  async (personal) => {
    const calls: string[] = []
    const docker = (async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      throw new DockerError(404, 'No such image')
    }) as Docker
    await expect(
      createCommandRunner({ docker, prefix: 'spyria-', personal }).run({ op: 'prepare', image: contentId }),
    ).rejects.toThrow('run bun run agent:build')
    expect(calls).toEqual([`GET /images/${contentId}/json`])
  },
)

test('refuses a prepare request with any field besides the image', () => {
  expect(() => parseCommand('prepare', { image, runtimeId: 'runtime-1' })).toThrow('refused')
  expect(() => parseCommand('prepare', { image, Binds: ['/:/host'] })).toThrow('refused')
})

test.each([
  ['host paths', { Binds: ['/:/host'] }],
  ['host path mounts', { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }],
  ['published ports', { PortBindings: { '8000/tcp': [{ HostPort: '8000' }] } }],
  ['all published ports', { PublishAllPorts: true }],
  ['privileged mode', { Privileged: true }],
  ['added capabilities', { CapAdd: ['SYS_ADMIN'] }],
  ['a host config', { HostConfig: { Privileged: true } }],
  ['the host network', { NetworkMode: 'host' }],
  ['devices', { Devices: [{ PathOnHost: '/dev/kvm' }] }],
  ['another user', { User: '0' }],
  ['extra environment', { Env: ['LD_PRELOAD=/tmp/x.so'] }],
])('refuses a create request with %s', (_, extraFields) => {
  expect(() => parseCommand('create', { ...create, ...extraFields })).toThrow('refused')
})

test.each(['../spyria-postgres', 'spyria-postgres/../x', 'Runtime', '', 'a'.repeat(64), 'runtime 1', 42])(
  'refuses the runtime id %p',
  (runtimeId) => {
    expect(() => parseCommand('start', { runtimeId })).toThrow('refused')
    expect(() => parseCommand('create', { ...create, runtimeId })).toThrow('refused')
  },
)

test.each(['short', `${'k'.repeat(32)}\nOTHER=1`, 'k'.repeat(300)])('refuses the API key %p', (refusedKey) => {
  expect(() => parseCommand('create', { ...create, apiKey: refusedKey })).toThrow('refused')
})

test('refuses extra arguments on start, stop, remove and status', () => {
  for (const op of ['start', 'stop', 'remove', 'status'])
    expect(() => parseCommand(op, { runtimeId: 'runtime-1', force: true })).toThrow('refused')
})

test('creates the container with exactly the hardening flags, an init that reaps orphaned processes, three named volumes and the host machine reachable by name', () => {
  expect(containerBodyOf({ prefix: 'spyria-', runtimeId: 'runtime-1', image, apiKey })).toEqual({
    Image: image,
    Hostname: 'spyria-rt-runtime-1',
    User: '10001:10001',
    Env: [`OH_SESSION_API_KEYS_0=${apiKey}`],
    Labels: { 'spyria.managed': '1', 'spyria.runtime': 'runtime-1' },
    HostConfig: {
      Init: true,
      NetworkMode: 'spyria-rt-runtime-1-net',
      ExtraHosts: ['host.docker.internal:host-gateway'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Privileged: false,
      PublishAllPorts: false,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
      Mounts: [
        { Type: 'volume', Source: 'spyria-rt-runtime-1-ws', Target: '/workspace' },
        { Type: 'volume', Source: 'spyria-rt-runtime-1-home', Target: '/home/spyria' },
        { Type: 'volume', Source: 'spyria-rt-runtime-1-tmp', Target: '/tmp' },
      ],
    },
  })
})

test('relays only to paths on the spyria-agent port of the runtime', () => {
  expect(relayUrlOf('http://172.20.0.2:8000', '/api/conversations?limit=5').href).toBe(
    'http://172.20.0.2:8000/api/conversations?limit=5',
  )
  for (const path of ['//evil.example/x', '@169.254.169.254/', 'http://169.254.169.254/', 'api', '/\\evil.example'])
    expect(() => relayUrlOf('http://172.20.0.2:8000', path)).toThrow('refused')
})

const recordingDocker = () => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const docker = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body })
    if (path.endsWith('/json') && path.startsWith('/containers/'))
      return {
        Config: { Labels: { 'spyria.managed': '1', 'spyria.runtime': 'runtime-1' } },
        NetworkSettings: { Networks: { 'spyria-rt-runtime-1-net': {} } },
      }
    return {}
  }) as Docker
  return { docker, calls }
}

test('a personal create mounts both credentials volumes and the harnesses read-only, a workspace create does not', () => {
  const personalMounts = containerBodyOf({ prefix: 'spyria-', ...create, personal: true }).HostConfig.Mounts
  expect(personalMounts.slice(-3)).toEqual([
    { Type: 'volume', Source: 'spyria-cred-claude-code', Target: '/home/spyria/.claude' },
    { Type: 'volume', Source: 'spyria-cred-codex', Target: '/home/spyria/.codex' },
    { Type: 'volume', Source: 'spyria-harnesses', Target: '/harnesses', ReadOnly: true },
  ])
  expect(personalMounts.slice(0, -3)).toEqual(containerBodyOf({ prefix: 'spyria-', ...create }).HostConfig.Mounts)
  expect(JSON.stringify(containerBodyOf({ prefix: 'spyria-', ...create }))).not.toContain('cred-')
  expect(JSON.stringify(containerBodyOf({ prefix: 'spyria-', ...create }))).not.toContain('harnesses')
})

test('a personal host creates the runtime with both credentials volumes after preparing their readers', async () => {
  const { docker, calls } = recordingDocker()
  await createCommandRunner({ docker, prefix: 'spyria-', personal: true }).run({ op: 'create', ...create })
  const created = calls.filter((call) => call.path.startsWith('/containers/create'))
  expect(created.map((call) => call.path)).toEqual([
    '/containers/create?name=spyria-cred-claude-code-reader',
    '/containers/create?name=spyria-cred-codex-reader',
    '/containers/create?name=spyria-rt-runtime-1',
  ])
  expect(JSON.stringify(created[1]?.body)).toContain('"Source":"spyria-cred-codex","Target":"/workspace/project"')
  expect(JSON.stringify(created[2]?.body)).toContain(
    '"Source":"spyria-cred-claude-code","Target":"/home/spyria/.claude"',
  )
  expect(JSON.stringify(created[2]?.body)).toContain('"Source":"spyria-cred-codex","Target":"/home/spyria/.codex"')
})

test('removing a runtime never deletes the credentials volumes', async () => {
  const { docker, calls } = recordingDocker()
  await createCommandRunner({ docker, prefix: 'spyria-', personal: true }).run({ op: 'remove', runtimeId: 'runtime-1' })
  const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path)
  expect(deleted).toEqual([
    '/containers/spyria-rt-runtime-1?force=true',
    '/containers/spyria-rt-runtime-1-snapshot?force=true',
    '/volumes/spyria-rt-runtime-1-ws',
    '/volumes/spyria-rt-runtime-1-home',
    '/volumes/spyria-rt-runtime-1-tmp',
    '/networks/spyria-rt-runtime-1-net',
  ])
})

test('each runtime gets its own network only while it runs: created and joined by a containerized spyria-host on create and start, released on stop and remove', async () => {
  const { docker, calls } = recordingDocker()
  const runner = createCommandRunner({ docker, prefix: 'spyria-', selfContainerId: 'self-1' })
  const joined = { Container: 'self-1', EndpointConfig: { Aliases: ['spyria-gateway-relay'] } }
  await runner.run({ op: 'create', ...create })
  expect(calls.filter((call) => call.path.startsWith('/networks/'))).toEqual([
    {
      method: 'POST',
      path: '/networks/create',
      body: { Name: 'spyria-rt-runtime-1-net', Driver: 'bridge', Labels: { 'spyria.managed': '1' } },
    },
    { method: 'POST', path: '/networks/spyria-rt-runtime-1-net/connect', body: joined },
  ])
  calls.splice(0)
  await runner.run({ op: 'start', runtimeId: 'runtime-1' })
  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /containers/spyria-rt-runtime-1/json',
    'POST /networks/create',
    'POST /networks/spyria-rt-runtime-1-net/connect',
    'POST /networks/spyria-rt-runtime-1-net/connect',
    'POST /containers/spyria-rt-runtime-1/start',
  ])
  expect(calls.filter((call) => call.path.endsWith('/connect')).map((call) => call.body)).toEqual([
    joined,
    { Container: 'spyria-rt-runtime-1' },
  ])
  const released = [
    {
      method: 'POST',
      path: '/networks/spyria-rt-runtime-1-net/disconnect',
      body: { Container: 'self-1', Force: true },
    },
    { method: 'DELETE', path: '/networks/spyria-rt-runtime-1-net', body: undefined },
  ]
  calls.splice(0)
  await runner.run({ op: 'stop', runtimeId: 'runtime-1' })
  expect(calls.map(({ method, path }) => `${method} ${path}`).slice(0, 2)).toEqual([
    'GET /containers/spyria-rt-runtime-1/json',
    'POST /containers/spyria-rt-runtime-1/stop?t=10',
  ])
  expect(calls.slice(2)).toEqual(released)
  calls.splice(0)
  await runner.run({ op: 'remove', runtimeId: 'runtime-1' })
  expect(calls.filter((call) => call.path.startsWith('/networks/'))).toEqual(released)
})

test('stop and remove of a runtime whose container is gone still release its network and volumes, but never touch an unmanaged container', async () => {
  const calls: string[] = []
  const missingDocker = (async (method: string, path: string) => {
    calls.push(`${method} ${path}`)
    if (path.startsWith('/containers/') && path.endsWith('/json')) throw new DockerError(404, 'No such container')
    return {}
  }) as Docker
  const runner = createCommandRunner({ docker: missingDocker, prefix: 'spyria-' })
  await runner.run({ op: 'stop', runtimeId: 'runtime-1' })
  expect(calls).toEqual(['GET /containers/spyria-rt-runtime-1/json', 'DELETE /networks/spyria-rt-runtime-1-net'])
  calls.splice(0)
  await runner.run({ op: 'remove', runtimeId: 'runtime-1' })
  expect(calls).toEqual([
    'GET /containers/spyria-rt-runtime-1/json',
    'DELETE /containers/spyria-rt-runtime-1-snapshot?force=true',
    'DELETE /volumes/spyria-rt-runtime-1-ws',
    'DELETE /volumes/spyria-rt-runtime-1-home',
    'DELETE /volumes/spyria-rt-runtime-1-tmp',
    'DELETE /networks/spyria-rt-runtime-1-net',
    `GET /volumes?filters=${encodeURIComponent(JSON.stringify({ name: ['spyria-cache-'], dangling: ['true'] }))}`,
  ])
  const { docker: unmanagedDocker, calls: unmanagedCalls } = recordingDocker()
  for (const op of ['start', 'stop', 'remove'] as const)
    await expect(
      createCommandRunner({ docker: unmanagedDocker, prefix: 'spyria-' }).run({ op, runtimeId: 'runtime-2' }),
    ).rejects.toThrow('not a managed runtime')
  expect(unmanagedCalls.filter((call) => call.method !== 'GET')).toEqual([])
})

test("two deployments on one Docker daemon never count or manage each other's runtimes, even when one name prefixes the other", async () => {
  const runtimeContainers = [
    { Names: ['/spyria-rt-a'], Labels: { 'spyria.managed': '1', 'spyria.runtime': 'a' } },
    { Names: ['/spyria-rt-rt-b'], Labels: { 'spyria.managed': '1', 'spyria.runtime': 'b' } },
    { Names: ['/spyria-prod-rt-c'], Labels: { 'spyria.managed': '1', 'spyria.runtime': 'c' } },
  ]
  const docker = (async (_method: string, path: string) => {
    if (path.startsWith('/containers/json')) return runtimeContainers
    const found = runtimeContainers.find(({ Names }) => path === `/containers${Names[0]}/json`)
    if (!found) throw new DockerError(404, 'No such container')
    return { Config: { Labels: found.Labels }, State: { Running: true } }
  }) as Docker
  const runnerOf = (deployment: string) => createCommandRunner({ docker, prefix: `${deployment}-` })
  for (const deployment of ['spyria', 'spyria-rt', 'spyria-prod'])
    expect(await runnerOf(deployment).runningCount()).toBe(1)
  expect(await runnerOf('spyria').run({ op: 'list' })).toEqual(['a'])
  expect(await runnerOf('spyria-rt').run({ op: 'list' })).toEqual(['b'])
  await expect(runnerOf('spyria').run({ op: 'status', runtimeId: 'rt-b' })).rejects.toThrow('not a managed runtime')
  expect(await runnerOf('spyria-rt').run({ op: 'status', runtimeId: 'b' })).toBe('running')
  expect(await runnerOf('spyria').run({ op: 'status', runtimeId: 'c' })).toBe('missing')
})

test('list names the runtimes of stopped containers too, while the running count counts running ones only', async () => {
  const paths: string[] = []
  const docker = (async (_method: string, path: string) => {
    paths.push(path)
    return []
  }) as Docker
  const runner = createCommandRunner({ docker, prefix: 'spyria-' })
  await runner.run({ op: 'list' })
  await runner.runningCount()
  expect(paths.map((path) => path.split('&')[0])).toEqual(['/containers/json?all=true', '/containers/json?all=false'])
})

test("removing a runtime deletes this deployment's package caches no container uses, keeps one a container took meanwhile, and never another deployment's volumes", async () => {
  const deleted: string[] = []
  const docker = (async (method: string, path: string) => {
    if (path.startsWith('/containers/') && path.endsWith('/json'))
      return { Config: { Labels: { 'spyria.managed': '1', 'spyria.runtime': 'runtime-1' } } }
    if (method === 'GET' && path.startsWith('/volumes?'))
      return {
        Volumes: [
          { Name: `spyria-cache-${'a'.repeat(32)}` },
          { Name: `spyria-cache-${'b'.repeat(32)}` },
          { Name: `other-spyria-cache-${'c'.repeat(32)}` },
          { Name: 'spyria-cache-cred-codex' },
          { Name: `spyria-cache-cache-${'d'.repeat(32)}` },
        ],
      }
    if (method === 'DELETE' && path === `/volumes/spyria-cache-${'b'.repeat(32)}`)
      throw new DockerError(409, 'volume is in use')
    if (method === 'DELETE' && path.startsWith('/volumes/')) deleted.push(path)
    return {}
  }) as Docker
  await createCommandRunner({ docker, prefix: 'spyria-' }).run({ op: 'remove', runtimeId: 'runtime-1' })
  expect(deleted).toEqual([
    '/volumes/spyria-rt-runtime-1-ws',
    '/volumes/spyria-rt-runtime-1-home',
    '/volumes/spyria-rt-runtime-1-tmp',
    `/volumes/spyria-cache-${'a'.repeat(32)}`,
  ])
})

const images = 'ghcr.io/camil-h'
const digest = `sha256:${'c'.repeat(64)}`
const publishedImage = `${images}/spyria-agent@${digest}`

test('accepts the deployment’s published runtime image by digest when the host knows where its images come from, and refuses it otherwise', () => {
  expect(parseCommand('prepare', { image: publishedImage }, images)).toEqual({ op: 'prepare', image: publishedImage })
  expect(parseCommand('create', { ...create, image: publishedImage }, images)).toMatchObject({ image: publishedImage })
  expect(parseCommand('create', create, images)).toEqual({ op: 'create', ...create })
  expect(() => parseCommand('prepare', { image: publishedImage })).toThrow('local content ID')
})

test.each([
  `${images}/spyria-agent:1.0.0`,
  `${images}/spyria-agent`,
  `${images}/spyria-host@${digest}`,
  `ghcr.io/evil/spyria-agent@${digest}`,
  `docker.io/${images}/spyria-agent@${digest}`,
  `${images}/spyria-agent@sha256:${'c'.repeat(63)}`,
  `${images}/spyria-agent@${digest}:latest`,
  `${images}/spyria-agent@${digest} --privileged`,
])(
  'refuses the image %p even when the host knows where its images come from, naming what it accepts',
  (refusedImage) => {
    expect(() => parseCommand('prepare', { image: refusedImage }, images)).toThrow(
      `${images}/spyria-agent@sha256:<digest>`,
    )
    expect(() => parseCommand('create', { ...create, image: refusedImage }, images)).toThrow('local content ID')
  },
)

const dockerWithPull = (pullAnswer: string) => {
  const calls: string[] = []
  let isPulled = false
  const docker = (async (method: string, path: string) => {
    calls.push(`${method} ${path}`)
    if (method === 'POST') {
      isPulled = true
      return pullAnswer
    }
    if (!isPulled) throw new DockerError(404, 'No such image')
    return {}
  }) as Docker
  return { docker, calls }
}

test('preparing a missing published image pulls it by digest, and a present one is not pulled', async () => {
  const { docker, calls } = dockerWithPull(
    '{"status":"Pulling from camil-h/spyria-agent"}\n{"status":"Downloaded newer image"}\n',
  )
  const runner = createCommandRunner({ docker, prefix: 'spyria-' })
  await runner.run({ op: 'prepare', image: publishedImage })
  expect(calls).toEqual([
    `GET /images/${publishedImage}/json`,
    `POST /images/create?fromImage=${encodeURIComponent(`${images}/spyria-agent`)}&tag=${digest}`,
  ])
  await runner.run({ op: 'prepare', image: publishedImage })
  expect(calls).toHaveLength(3)
})

test('a pull the registry refuses fails with its reason', async () => {
  const { docker } = dockerWithPull(
    '{"status":"Pulling"}\n{"error":"manifest unknown","errorDetail":{"message":"manifest unknown"}}\n',
  )
  await expect(
    createCommandRunner({ docker, prefix: 'spyria-' }).run({ op: 'prepare', image: publishedImage }),
  ).rejects.toThrow('manifest unknown')
})

test('a recreate removes the managed container alone and creates it again on the same volumes; without a container it just creates', async () => {
  const calls: string[] = []
  const bodies: ReturnType<typeof containerBodyOf>[] = []
  let exists = true
  const docker = (async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path.split('?')[0]}`)
    if (method === 'POST' && path.startsWith('/containers/create'))
      bodies.push(body as ReturnType<typeof containerBodyOf>)
    if (method === 'GET' && path.startsWith('/containers/')) {
      if (!exists) throw new DockerError(404, 'No such container')
      return { Config: { Labels: { 'spyria.managed': '1', 'spyria.runtime': 'runtime-1' } } }
    }
    if (method === 'DELETE') exists = false
    return {}
  }) as Docker
  const runner = createCommandRunner({ docker, prefix: 'spyria-' })
  await runner.run({ op: 'recreate', ...create })
  expect(calls).toEqual([
    'GET /containers/spyria-rt-runtime-1/json',
    'DELETE /containers/spyria-rt-runtime-1',
    'POST /networks/create',
    `GET /images/${image}/json`,
    'POST /containers/create',
  ])
  expect(bodies[0]?.HostConfig.Mounts.map(({ Source }) => Source)).toEqual([
    'spyria-rt-runtime-1-ws',
    'spyria-rt-runtime-1-home',
    'spyria-rt-runtime-1-tmp',
  ])
  calls.length = 0
  await runner.run({ op: 'recreate', ...create })
  expect(calls).toEqual([
    'GET /containers/spyria-rt-runtime-1/json',
    'POST /networks/create',
    `GET /images/${image}/json`,
    'POST /containers/create',
  ])
  expect(parseCommand('recreate', create)).toEqual({ op: 'recreate', ...create })
  expect(() => parseCommand('recreate', { runtimeId: 'runtime-1' })).toThrow('refused')
})

const snapshotKey = 'd'.repeat(32)
const otherSnapshotKey = 'e'.repeat(32)
const snapshotVolumeOf = (key: string, generation: string) => ({
  Name: `spyria-snapshot-${key}-${generation}`,
  Labels: { 'spyria.managed': '1', 'spyria.snapshot': key },
})

const snapshotDocker = ({
  volumes = [] as ReturnType<typeof snapshotVolumeOf>[],
  copyExitCode = 0,
  inUse = [] as string[],
} = {}) => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const docker = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body })
    if (path.startsWith('/volumes?')) return { Volumes: volumes }
    if (path.endsWith('/wait')) return { StatusCode: copyExitCode }
    if (method === 'DELETE' && inUse.some((name) => path === `/volumes/${name}`))
      throw new DockerError(409, 'volume is in use')
    if (path.startsWith('/containers/') && path.endsWith('/json'))
      return { Config: { Image: image, Labels: { 'spyria.managed': '1', 'spyria.runtime': 'runtime-1' } } }
    return {}
  }) as Docker
  return { docker, calls, requests: () => calls.map(({ method, path }) => `${method} ${path.split('?')[0]}`) }
}

test('accepts a snapshot of a runtime and a prune of the snapshots to keep, and refuses any other key or field', () => {
  expect(parseCommand('create', { ...create, snapshotKey })).toEqual({ op: 'create', ...create, snapshotKey })
  expect(parseCommand('snapshot', { runtimeId: 'runtime-1', snapshotKey })).toEqual({
    op: 'snapshot',
    runtimeId: 'runtime-1',
    snapshotKey,
  })
  expect(parseCommand('prune_snapshots', { keep: [snapshotKey] })).toEqual({
    op: 'prune_snapshots',
    keep: [snapshotKey],
  })
  for (const refusedKey of ['../spyria-host', snapshotKey.toUpperCase(), `${snapshotKey}0`, 42]) {
    expect(() => parseCommand('snapshot', { runtimeId: 'runtime-1', snapshotKey: refusedKey })).toThrow('refused')
    expect(() => parseCommand('create', { ...create, snapshotKey: refusedKey })).toThrow('refused')
    expect(() => parseCommand('prune_snapshots', { keep: [refusedKey] })).toThrow('refused')
  }
  expect(() => parseCommand('prune_snapshots', { keep: snapshotKey })).toThrow('refused')
  expect(() => parseCommand('snapshot', { runtimeId: 'runtime-1', snapshotKey, path: '/' })).toThrow('refused')
})

test('a create with a snapshot key mounts the newest snapshot of that key read-only at the snapshot directory; without a snapshot on the host, none is mounted', async () => {
  const mountsOfCreate = async (volumes: ReturnType<typeof snapshotVolumeOf>[]) => {
    const { docker, calls } = snapshotDocker({ volumes })
    await createCommandRunner({ docker, prefix: 'spyria-' }).run({ op: 'create', ...create, snapshotKey })
    const created = calls.find((call) => call.path.startsWith('/containers/create'))?.body as ReturnType<
      typeof containerBodyOf
    >
    return created.HostConfig.Mounts.filter((mount) => mount.Target === '/var/lib/spyria/snapshot')
  }
  expect(
    await mountsOfCreate([
      snapshotVolumeOf(snapshotKey, '00mabc001'),
      snapshotVolumeOf(snapshotKey, '00mabc002'),
      { ...snapshotVolumeOf(snapshotKey, '00mabc009'), Name: `other-snapshot-${snapshotKey}-00mabc009` },
    ]),
  ).toEqual([
    {
      Type: 'volume',
      Source: `spyria-snapshot-${snapshotKey}-00mabc002`,
      Target: '/var/lib/spyria/snapshot',
      ReadOnly: true,
    },
  ])
  expect(await mountsOfCreate([])).toEqual([])
})

test('a snapshot pauses the runtime while a container with no network copies its project and home, read-only, into a new labelled volume, then removes the older snapshots of that repository only', async () => {
  const { docker, calls, requests } = snapshotDocker({
    volumes: [
      snapshotVolumeOf(snapshotKey, '00mabc001'),
      snapshotVolumeOf(snapshotKey, '00mzzz999'),
      snapshotVolumeOf(otherSnapshotKey, '00mabc001'),
    ],
  })
  await createCommandRunner({ docker, prefix: 'spyria-' }).run({ op: 'snapshot', runtimeId: 'runtime-1', snapshotKey })
  const created = calls.find((call) => call.path === '/volumes/create')?.body as { Name: string; Labels: object }
  expect(created.Name).toMatch(new RegExp(`^spyria-snapshot-${snapshotKey}-[0-9a-z]{9}$`))
  expect(created.Labels).toEqual({ 'spyria.managed': '1', 'spyria.snapshot': snapshotKey })
  const copier = calls.find((call) => call.path === '/containers/create?name=spyria-rt-runtime-1-snapshot')
    ?.body as ReturnType<typeof containerBodyOf> & { Entrypoint: string[] }
  expect(copier.Image).toBe(image)
  expect(copier.User).toBe('10001:10001')
  expect(copier.HostConfig).toMatchObject({ NetworkMode: 'none', CapDrop: ['ALL'], ReadonlyRootfs: true })
  expect(copier.HostConfig.Mounts).toEqual([
    { Type: 'volume', Source: 'spyria-rt-runtime-1-ws', Target: '/workspace', ReadOnly: true },
    { Type: 'volume', Source: 'spyria-rt-runtime-1-home', Target: '/home/spyria', ReadOnly: true },
    { Type: 'volume', Source: created.Name, Target: '/var/lib/spyria/snapshot' },
  ])
  expect(copier.Entrypoint.at(-1)).toEndWith('touch /var/lib/spyria/snapshot/complete')
  expect(requests().slice(requests().indexOf('POST /containers/spyria-rt-runtime-1/pause'))).toEqual([
    'POST /containers/spyria-rt-runtime-1/pause',
    'POST /containers/spyria-rt-runtime-1-snapshot/start',
    'POST /containers/spyria-rt-runtime-1-snapshot/wait',
    'POST /containers/spyria-rt-runtime-1/unpause',
    'DELETE /containers/spyria-rt-runtime-1-snapshot',
    'GET /volumes',
    `DELETE /volumes/spyria-snapshot-${snapshotKey}-00mabc001`,
  ])
})

test('a snapshot whose copy fails resumes the runtime, removes the half-copied volume and fails; a personal host refuses snapshots', async () => {
  const { docker, requests } = snapshotDocker({ copyExitCode: 1 })
  const failed = await createCommandRunner({ docker, prefix: 'spyria-' })
    .run({ op: 'snapshot', runtimeId: 'runtime-1', snapshotKey })
    .then(
      () => undefined,
      (error: Error) => error,
    )
  expect(failed?.message).toBe('Copying the snapshot failed with exit code 1')
  expect(requests()).toContain('POST /containers/spyria-rt-runtime-1/unpause')
  expect(requests().at(-1)).toMatch(new RegExp(`^DELETE /volumes/spyria-snapshot-${snapshotKey}-`))
  const personal = createCommandRunner({ docker, prefix: 'spyria-', personal: true })
  for (const command of [
    { op: 'snapshot', runtimeId: 'runtime-1', snapshotKey },
    { op: 'prune_snapshots', keep: [] },
  ] satisfies Command[])
    expect(await personal.run(command).catch((error: Error) => error.message)).toBe(
      'refused: snapshots are taken only on a workspace host',
    )
})

test('pruning keeps the newest snapshot of each kept repository and removes the rest, leaving a snapshot in use for later', async () => {
  const inUse = `spyria-snapshot-${otherSnapshotKey}-00mabc002`
  const { docker, requests } = snapshotDocker({
    volumes: [
      snapshotVolumeOf(snapshotKey, '00mabc001'),
      snapshotVolumeOf(snapshotKey, '00mabc002'),
      snapshotVolumeOf(otherSnapshotKey, '00mabc002'),
    ],
    inUse: [inUse],
  })
  await createCommandRunner({ docker, prefix: 'spyria-' }).run({ op: 'prune_snapshots', keep: [snapshotKey] })
  expect(requests().filter((request) => request.startsWith('DELETE'))).toEqual([
    `DELETE /volumes/${inUse}`,
    `DELETE /volumes/spyria-snapshot-${snapshotKey}-00mabc001`,
  ])
})
