import type { ChatId, RuntimeHostId, RuntimeId, WarmPool, WorkspaceId } from '@spyria/kernel'
import { type HostLoad, placementOf, type Runtime } from './runtime.ts'

export type WarmRuntimeState = 'creating' | 'preparing' | 'ready'
export type WarmRuntime = Readonly<{
  workspaceId: WorkspaceId
  id: RuntimeId
  repository: string
  setupCommand: string
  hostId: RuntimeHostId
  state: WarmRuntimeState
  image: string
  apiKeyId: string
  baseBranch: string | null
  agentVersion: string | null
  agentProtocolVersion: number | null
  createdAt: number
  stateChangedAt: number
}>
export type ClaimScope = Readonly<{ repository: string; baseBranch: string; setupCommand: string }>
export type SetupSnapshotScope = Readonly<{ repository: string; setupCommand: string }>
export type Preparation =
  | { state: 'preparing' }
  | { state: 'ready'; branch: string; isSetUp: boolean }
  | { state: 'failed'; failure: string }

const minute = 60_000
const readyLifetimeMilliseconds = 24 * 60 * minute
const preparingLimitMilliseconds = 60 * minute
export const warmCheckIntervalMilliseconds = 10_000

const isStale = (warm: WarmRuntime, pools: readonly WarmPool[], currentImage: string, now: number) => {
  const pool = pools.find(({ repository }) => repository === warm.repository)
  const age = warm.state === 'ready' ? now - warm.stateChangedAt : now - warm.createdAt
  return (
    !pool ||
    pool.command !== warm.setupCommand ||
    warm.image !== currentImage ||
    age > (warm.state === 'ready' ? readyLifetimeMilliseconds : preparingLimitMilliseconds)
  )
}

const readyFirst = (first: WarmRuntime, second: WarmRuntime) =>
  Number(second.state === 'ready') - Number(first.state === 'ready') || second.createdAt - first.createdAt

export const warmPoolPlanOf = (
  warm: readonly WarmRuntime[],
  pools: readonly WarmPool[],
  currentImage: string,
  now: number,
) => {
  const stale = warm.filter((known) => isStale(known, pools, currentImage, now))
  const kept = warm.filter((known) => !stale.includes(known))
  const keptOf = (pool: WarmPool) => kept.filter(({ repository }) => repository === pool.repository)
  return {
    removed: [...stale, ...pools.flatMap((pool) => keptOf(pool).toSorted(readyFirst).slice(pool.size))],
    missing: pools.flatMap((pool) => Array.from({ length: Math.max(0, pool.size - keptOf(pool).length) }, () => pool)),
  }
}

export const warmPlacementOf = (hosts: readonly HostLoad[]) =>
  placementOf(hosts.map((host) => ({ ...host, cap: host.cap - 1 })))

export const isPreparingTooLong = (warm: WarmRuntime, now: number) => now - warm.createdAt > preparingLimitMilliseconds

export const preparationOf = (body: unknown): Preparation => {
  const { state, branch, isSetUp, failure } = (body ?? {}) as Record<string, unknown>
  if (state === 'preparing') return { state }
  if (state === 'ready' && typeof branch === 'string' && branch !== '')
    return { state, branch, isSetUp: isSetUp === true }
  return { state: 'failed', failure: typeof failure === 'string' ? failure : 'The runtime could not be prepared' }
}

export const isClaimable = (warm: WarmRuntime, scope: ClaimScope, currentImage: string | undefined) =>
  warm.state === 'ready' &&
  warm.repository === scope.repository &&
  warm.baseBranch === scope.baseBranch &&
  warm.setupCommand === scope.setupCommand &&
  warm.image === currentImage

export const runtimeOfClaimed = (warm: WarmRuntime, chatId: ChatId, now: number): Runtime => ({
  workspaceId: warm.workspaceId,
  id: warm.id,
  chatId,
  hostId: warm.hostId,
  state: 'running',
  failure: null,
  hostOnline: true,
  image: warm.image,
  agentVersion: warm.agentVersion,
  agentProtocolVersion: warm.agentProtocolVersion,
  lastActiveAt: now,
  createdAt: now,
  stateChangedAt: now,
})
