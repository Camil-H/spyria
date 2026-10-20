import type { ChatId, RuntimeHostId, RuntimeId, WorkspaceId } from '@spyria/kernel'
import { TransitionRefused } from './errors.ts'

export type RuntimeState =
  | 'creating'
  | 'installing'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'starting'
  | 'removing'
  | 'removed'
  | 'failed'
const installFailedPrefix = 'install_failed: '
export type RuntimeFailure =
  | 'no_host'
  | 'no_capacity'
  | 'no_image'
  | 'create_failed'
  | 'start_failed'
  | 'lost'
  | `${typeof installFailedPrefix}${string}`
export const installFailureOf = (reason: string): RuntimeFailure => `${installFailedPrefix}${reason}`
export const installFailureReasonOf = (failure: string | null | undefined) =>
  failure?.startsWith(installFailedPrefix) ? failure.slice(installFailedPrefix.length) : undefined

export type Runtime = Readonly<{
  workspaceId: WorkspaceId
  id: RuntimeId
  chatId: ChatId
  hostId: RuntimeHostId | null
  state: RuntimeState
  failure: RuntimeFailure | null
  hostOnline: boolean
  image: string
  lastActiveAt: number
  createdAt: number
  stateChangedAt: number
}>

export type HostLoad = { hostId: RuntimeHostId; online: boolean; cap: number; running: number }

export const runtimeJobTypes = {
  create: 'runtime.create',
  start: 'runtime.start',
  stop: 'runtime.stop',
  remove: 'runtime.remove',
  sweep: 'runtime.sweep',
} as const

const nextStates: Record<RuntimeState, readonly RuntimeState[]> = {
  creating: ['installing', 'running', 'removing', 'failed'],
  starting: ['installing', 'running', 'removing', 'failed'],
  installing: ['running', 'removing', 'failed'],
  running: ['stopping', 'stopped', 'removing', 'failed'],
  stopping: ['stopped', 'removing', 'failed'],
  stopped: ['starting', 'running', 'removing', 'failed'],
  removing: ['removed', 'failed'],
  failed: ['removing', 'removed', 'failed'],
  removed: [],
}
const minute = 60_000
const idleStopMilliseconds = 60 * minute
const idleRemovalMilliseconds = 30 * 24 * 60 * minute
export const sweepIntervalMilliseconds = 5 * minute

export const canTransition = (from: RuntimeState, to: RuntimeState) => nextStates[from].includes(to)

export const transitioned = (
  runtime: Runtime,
  state: RuntimeState,
  now: number,
  failure: RuntimeFailure | null = null,
): Runtime => {
  if (!canTransition(runtime.state, state)) throw new TransitionRefused(runtime.state, state)
  return { ...runtime, state, failure, stateChangedAt: now }
}

export const ensureStepOf = (runtime: Runtime | undefined) => {
  if (
    !runtime ||
    runtime.state === 'removed' ||
    runtime.failure === 'no_host' ||
    runtime.failure === 'no_capacity' ||
    runtime.failure === 'no_image'
  )
    return 'place'
  if (runtime.state === 'stopped') return 'start'
  if (runtime.state === 'running') return 'touch'
  return 'none'
}

type Placement = { hostId: RuntimeHostId; failure?: undefined } | { hostId?: undefined; failure: RuntimeFailure }

export const placementOf = (hosts: readonly HostLoad[]): Placement => {
  const online = hosts.filter((host) => host.online)
  if (online.length === 0) return { failure: 'no_host' }
  const [leastLoaded] = online
    .filter((host) => host.running < host.cap)
    .toSorted((first, second) => first.running / first.cap - second.running / second.cap)
  return leastLoaded ? { hostId: leastLoaded.hostId } : { failure: 'no_capacity' }
}

export const idleStepOf = (runtime: Runtime, now: number) => {
  const idleMilliseconds = now - runtime.lastActiveAt
  if (runtime.state === 'running' && idleMilliseconds > idleStopMilliseconds) return 'stopping'
  if (runtime.state === 'stopped' && idleMilliseconds > idleRemovalMilliseconds) return 'removing'
  return undefined
}

export const isTouchDue = (runtime: Runtime, now: number) =>
  runtime.state === 'running' && now - runtime.lastActiveAt >= minute

export const removalStepOf = (runtime: Runtime) => {
  if (!canTransition(runtime.state, 'removing')) return undefined
  return runtime.hostId === null || runtime.failure === 'lost' ? 'removed' : 'removing'
}

export const reconciledStateOf = (runtime: Runtime, status: 'running' | 'stopped' | 'missing') => {
  const observed = status === 'running' ? 'running' : 'stopped'
  return (runtime.state === 'running' || runtime.state === 'stopped') && runtime.state !== observed
    ? observed
    : undefined
}

export type RuntimeStatus =
  | 'Not started'
  | 'Starting…'
  | `Installing ${string}…`
  | 'Ready'
  | 'Sleeping'
  | 'Host offline'
  | 'Could not start'

const statusByState: Record<RuntimeState, RuntimeStatus> = {
  creating: 'Starting…',
  starting: 'Starting…',
  installing: 'Starting…',
  running: 'Ready',
  stopping: 'Sleeping',
  stopped: 'Sleeping',
  failed: 'Could not start',
  removing: 'Could not start',
  removed: 'Could not start',
}

export const isAwaitingHost = (runtime: Pick<Runtime, 'state' | 'hostOnline'>) =>
  !runtime.hostOnline && (runtime.state === 'running' || runtime.state === 'stopped')

export const runtimeStatusOf = (
  runtime: Pick<Runtime, 'state' | 'hostOnline'> | undefined,
  harnessName?: string,
): RuntimeStatus => {
  if (!runtime) return 'Not started'
  if (runtime.state === 'installing' && harnessName) return `Installing ${harnessName}…`
  return isAwaitingHost(runtime) ? 'Host offline' : statusByState[runtime.state]
}

export const isRetryable = (runtime: Runtime | undefined) => runtime?.state === 'failed' || runtime?.state === 'removed'

export const locationOf = (runtime: Runtime) =>
  runtime.hostId === null
    ? undefined
    : { workspaceId: runtime.workspaceId, hostId: runtime.hostId, runtimeId: runtime.id }
