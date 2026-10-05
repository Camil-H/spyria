import { expect, test } from 'bun:test'
import { containerBodyOf, parseCommand, relayUrlOf } from './commands.ts'

const image = `ghcr.io/openhands/agent-server@sha256:${'a'.repeat(64)}`
const apiKey = 'k'.repeat(32)
const create = { runtimeId: 'runtime-1', image, apiKey }

test('accepts exactly create, start, stop, remove and status with their arguments', () => {
  expect(parseCommand('create', create)).toEqual({ op: 'create', ...create })
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
