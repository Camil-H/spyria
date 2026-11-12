import { expect, test } from 'bun:test'
import { chatId, runtimeHostId, runtimeId, workspaceId } from '@spyria/kernel'
import {
  isClaimable,
  isCountedOnHost,
  type Preparation,
  preparationOf,
  runtimeOfClaimed,
  type WarmRuntime,
  warmPlacementOf,
  warmPoolPlanOf,
} from './warm-runtime.ts'

const hour = 3_600_000
const now = 100 * hour
const image = 'sha256:current'
const warmRuntime = (overrides: Partial<WarmRuntime> = {}): WarmRuntime => ({
  workspaceId: workspaceId('acme'),
  id: runtimeId(`warm-${crypto.randomUUID()}`),
  repository: 'acme/app',
  setupCommand: 'bun install',
  hostId: runtimeHostId('host-1'),
  state: 'ready',
  image,
  apiKeyId: 'key-1',
  baseBranch: 'main',
  agentVersion: '1.0.0',
  agentProtocolVersion: 2,
  createdAt: now - hour,
  stateChangedAt: now - hour,
  ...overrides,
})
const appPool = { repository: 'acme/app', command: 'bun install', size: 2 }

test('a pool short of runtimes asks for the missing ones; a full pool asks for nothing', () => {
  expect(warmPoolPlanOf([], [appPool], image, now)).toEqual({ removed: [], missing: [appPool, appPool] })
  const full = [warmRuntime(), warmRuntime({ state: 'creating' })]
  expect(warmPoolPlanOf(full, [appPool], image, now)).toEqual({ removed: [], missing: [] })
})

test.each([
  ['its repository keeps no runtime ready', warmRuntime({ repository: 'acme/site' })],
  ['its setup command changed', warmRuntime({ setupCommand: 'npm ci' })],
  ['it runs an older runtime image', warmRuntime({ image: 'sha256:old' })],
  ['it has been ready for more than a day', warmRuntime({ stateChangedAt: now - 25 * hour })],
  ['it has been preparing for more than an hour', warmRuntime({ state: 'preparing', createdAt: now - 2 * hour })],
  ['it failed more than an hour ago', warmRuntime({ state: 'failed', stateChangedAt: now - 2 * hour })],
])('a runtime kept ready is replaced when %s', (_, stale) => {
  expect(warmPoolPlanOf([stale], [appPool], image, now)).toEqual({
    removed: [stale],
    missing: [appPool, appPool],
  })
})

test('a runtime that failed within the hour holds its place in the pool, so a failing repository is retried once an hour at most', () => {
  const failed = warmRuntime({ state: 'failed', stateChangedAt: now - 30 * 60_000 })
  expect(warmPoolPlanOf([failed], [{ ...appPool, size: 1 }], image, now)).toEqual({ removed: [], missing: [] })
})

test('a pool made smaller keeps its newest ready runtimes and removes the older ready ones, those still preparing and the failed ones', () => {
  const oldest = warmRuntime({ createdAt: now - 3 * hour })
  const newest = warmRuntime({ createdAt: now - hour })
  const preparing = warmRuntime({ state: 'preparing', createdAt: now - 1000 })
  const failed = warmRuntime({ state: 'failed', createdAt: now - 500 })
  const { removed, missing } = warmPoolPlanOf(
    [oldest, failed, preparing, newest],
    [{ ...appPool, size: 1 }],
    image,
    now,
  )
  expect(removed).toEqual([oldest, preparing, failed])
  expect(missing).toEqual([])
})

test('only a failed runtime kept ready is not counted on its host: its container was removed', () => {
  expect(isCountedOnHost(warmRuntime({ state: 'failed' }))).toBe(false)
  for (const state of ['creating', 'preparing', 'ready'] as const)
    expect(isCountedOnHost(warmRuntime({ state }))).toBe(true)
})

test('runtimes kept ready never take the last slot of a host, so a chat always finds room', () => {
  const host = { hostId: runtimeHostId('host-1'), online: true, cap: 2, running: 0 }
  expect(warmPlacementOf([host])).toEqual({ hostId: host.hostId })
  expect(warmPlacementOf([{ ...host, running: 1 }])).toEqual({ failure: 'no_capacity' })
  expect(warmPlacementOf([{ ...host, online: false }])).toEqual({ failure: 'no_host' })
})

test('a chat takes only a ready runtime of its repository, base branch, setup command and the current image', () => {
  const scope = { repository: 'acme/app', baseBranch: 'main', setupCommand: 'bun install' }
  expect(isClaimable(warmRuntime(), scope, image)).toBe(true)
  for (const other of [
    warmRuntime({ state: 'preparing' }),
    warmRuntime({ repository: 'acme/site' }),
    warmRuntime({ baseBranch: 'develop' }),
    warmRuntime({ setupCommand: 'npm ci' }),
    warmRuntime({ image: 'sha256:old' }),
  ])
    expect(isClaimable(other, scope, image)).toBe(false)
})

test('the claimed runtime is running for the chat at once, on the host and image it was prepared on', () => {
  const warm = warmRuntime()
  expect(runtimeOfClaimed(warm, chatId('chat-1'), now)).toEqual({
    workspaceId: warm.workspaceId,
    id: warm.id,
    chatId: chatId('chat-1'),
    hostId: warm.hostId,
    state: 'running',
    failure: null,
    hostOnline: true,
    image,
    agentVersion: '1.0.0',
    agentProtocolVersion: 2,
    lastActiveAt: now,
    createdAt: now,
    stateChangedAt: now,
  })
})

test.each<[unknown, Preparation]>([
  [{ state: 'preparing' }, { state: 'preparing' }],
  [
    { state: 'ready', branch: 'main', isSetUp: true },
    { state: 'ready', branch: 'main', isSetUp: true },
  ],
  [
    { state: 'ready', branch: 'main' },
    { state: 'ready', branch: 'main', isSetUp: false },
  ],
  [{ state: 'ready' }, { state: 'failed', failure: 'The runtime could not be prepared' }],
  [
    { state: 'failed', failure: 'The repository could not be cloned' },
    { state: 'failed', failure: 'The repository could not be cloned' },
  ],
  [null, { state: 'failed', failure: 'The runtime could not be prepared' }],
])('the agent’s preparation %p reads as %p', (body, preparation) => {
  expect(preparationOf(body)).toEqual(preparation)
})
