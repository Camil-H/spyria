import { expect, test } from 'bun:test'
import { containerBodyOf, createCommandRunner, parseCommand, relayUrlOf } from './commands.ts'
import { type Docker, DockerError } from './docker.ts'

const image = `ghcr.io/openhands/agent-server@sha256:${'a'.repeat(64)}`
const apiKey = 'k'.repeat(32)
const create = { runtimeId: 'runtime-1', image, apiKey }

test('accepts exactly create, prepare, start, stop, remove and status with their arguments', () => {
  expect(parseCommand('create', create)).toEqual({ op: 'create', ...create })
  expect(parseCommand('prepare', { image })).toEqual({ op: 'prepare', image })
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
  'docker.io/library/alpine:3',
  'ghcr.io/openhands/agent-server:1.51.0-python',
  'ghcr.io/openhands/agent-server@sha256:abc',
  `ghcr.io/openhands/agent-server@sha256:${'A'.repeat(64)}`,
  `ghcr.io/evil/agent-server@sha256:${'a'.repeat(64)}`,
  `evil.io/ghcr.io/openhands/agent-server@sha256:${'a'.repeat(64)}`,
  `ghcr.io/openhands/agent-server@sha256:${'a'.repeat(64)} --privileged`,
])('refuses the image %p', (refusedImage) => {
  expect(() => parseCommand('create', { ...create, image: refusedImage })).toThrow('refused')
  expect(() => parseCommand('prepare', { image: refusedImage })).toThrow('refused')
})

const contentId = `sha256:${'b'.repeat(64)}`

test('a personal host accepts only a local content ID, a workspace host the Agent Server image or a local content ID', () => {
  expect(parseCommand('create', { ...create, image: contentId }, true)).toEqual({
    op: 'create',
    ...create,
    image: contentId,
  })
  expect(parseCommand('prepare', { image: contentId }, true)).toEqual({ op: 'prepare', image: contentId })
  expect(() => parseCommand('create', create, true)).toThrow('local content ID')
  expect(() => parseCommand('prepare', { image }, true)).toThrow('refused')
  expect(() => parseCommand('prepare', { image: `sha256:${'b'.repeat(63)}` }, true)).toThrow('refused')
  expect(parseCommand('create', { ...create, image: contentId })).toEqual({ op: 'create', ...create, image: contentId })
  expect(parseCommand('prepare', { image: contentId })).toEqual({ op: 'prepare', image: contentId })
  expect(() => parseCommand('prepare', { image: `sha256:${'b'.repeat(63)}` })).toThrow('refused')
})

test('a personal create sets only the session key in the environment', () => {
  expect(containerBodyOf({ prefix: 'hq-', ...create, image: contentId, personal: true }).Env).toEqual([
    `OH_SESSION_API_KEYS_0=${apiKey}`,
  ])
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
      createCommandRunner({ docker, prefix: 'hq-', personal }).run({ op: 'prepare', image: contentId }),
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

test.each(['../hq-postgres', 'hq-postgres/../x', 'Runtime', '', 'a'.repeat(64), 'runtime 1', 42])(
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

test('creates the container with exactly the hardening flags and three named volumes', () => {
  expect(containerBodyOf({ prefix: 'hq-', runtimeId: 'runtime-1', image, apiKey })).toEqual({
    Image: image,
    Hostname: 'hq-rt-runtime-1',
    User: '10001:10001',
    Env: [
      `OH_SESSION_API_KEYS_0=${apiKey}`,
      'OH_ENABLE_VSCODE=false',
      'OH_ENABLE_BROWSER=false',
      'OH_PRELOAD_TOOLS=false',
      'OPENHANDS_SUPPRESS_BANNER=1',
    ],
    Labels: { 'hq.managed': '1', 'hq.runtime': 'runtime-1' },
    HostConfig: {
      NetworkMode: 'hq-runtimes',
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
        { Type: 'volume', Source: 'hq-rt-runtime-1-ws', Target: '/workspace' },
        { Type: 'volume', Source: 'hq-rt-runtime-1-home', Target: '/home/openhands' },
        { Type: 'volume', Source: 'hq-rt-runtime-1-tmp', Target: '/tmp' },
      ],
    },
  })
})

test('relays only to paths on the Agent Server port of the runtime', () => {
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
      return { Config: { Labels: { 'hq.managed': '1', 'hq.runtime': 'runtime-1' } } }
    return {}
  }) as Docker
  return { docker, calls }
}

test('a personal create mounts both credentials volumes at ~/.claude and ~/.codex, a workspace create does not', () => {
  const personalMounts = containerBodyOf({ prefix: 'hq-', ...create, personal: true }).HostConfig.Mounts
  expect(personalMounts.slice(-2)).toEqual([
    { Type: 'volume', Source: 'hq-cred-claude', Target: '/home/openhands/.claude' },
    { Type: 'volume', Source: 'hq-cred-codex', Target: '/home/openhands/.codex' },
  ])
  expect(personalMounts.slice(0, -2)).toEqual(containerBodyOf({ prefix: 'hq-', ...create }).HostConfig.Mounts)
  expect(JSON.stringify(containerBodyOf({ prefix: 'hq-', ...create }))).not.toContain('cred-')
})

test('a personal host creates the runtime with both credentials volumes after preparing their readers', async () => {
  const { docker, calls } = recordingDocker()
  await createCommandRunner({ docker, prefix: 'hq-', personal: true }).run({ op: 'create', ...create })
  const created = calls.filter((call) => call.path.startsWith('/containers/create'))
  expect(created.map((call) => call.path)).toEqual([
    '/containers/create?name=hq-cred-claude-reader',
    '/containers/create?name=hq-cred-codex-reader',
    '/containers/create?name=hq-rt-runtime-1',
  ])
  expect(JSON.stringify(created[1]?.body)).toContain('"Source":"hq-cred-codex","Target":"/workspace/project"')
  expect(JSON.stringify(created[2]?.body)).toContain('"Source":"hq-cred-claude","Target":"/home/openhands/.claude"')
  expect(JSON.stringify(created[2]?.body)).toContain('"Source":"hq-cred-codex","Target":"/home/openhands/.codex"')
})

test('removing a runtime never deletes the credentials volumes', async () => {
  const { docker, calls } = recordingDocker()
  await createCommandRunner({ docker, prefix: 'hq-', personal: true }).run({ op: 'remove', runtimeId: 'runtime-1' })
  const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path)
  expect(deleted).toEqual([
    '/containers/hq-rt-runtime-1?force=true',
    '/volumes/hq-rt-runtime-1-ws',
    '/volumes/hq-rt-runtime-1-home',
    '/volumes/hq-rt-runtime-1-tmp',
  ])
})
