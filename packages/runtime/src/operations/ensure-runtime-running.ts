import { type ChatId, runtimeId, type WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { RetryRefused, RuntimeChatArchived } from '../domain/errors.ts'
import {
  ensureStepOf,
  isAwaitingHost,
  isRetryable,
  placementOf,
  type Runtime,
  runtimeJobTypes,
  transitioned,
} from '../domain/runtime.ts'
import { isClaimable, runtimeOfClaimed } from '../domain/warm-runtime.ts'

export type RuntimePlacement = { spyriaAgentImage?: string }
type Dependencies = RuntimePlacement & { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; id: string; now: number }

const claimedWarmRuntime = async (
  { runtimes, warmRuntimes, jobs }: UnitOfWork,
  { workspaceId, chatId, now }: Input,
  spyriaAgentImage: string | undefined,
) => {
  const scope = await runtimes.claimScopeOf(workspaceId, chatId)
  if (!scope || !spyriaAgentImage) return undefined
  const warm = await warmRuntimes.lockClaimable(workspaceId, scope, spyriaAgentImage)
  if (!warm || !isClaimable(warm, scope, spyriaAgentImage)) return undefined
  const runtime = runtimeOfClaimed(warm, chatId, now)
  await warmRuntimes.delete(warm)
  await runtimes.add(runtime)
  await runtimes.keepApiKeyId(runtime, warm.apiKeyId)
  await jobs.enqueue(workspaceId, runtimeJobTypes.warm, {})
  return runtime
}

const placeRuntime = async (
  unitOfWork: UnitOfWork,
  { workspaceId, chatId, id, now }: Input,
  existing: Runtime | undefined,
  { spyriaAgentImage }: RuntimePlacement,
) => {
  const { runtimes, runtimeHosts, secrets, jobs } = unitOfWork
  if (existing) {
    await secrets.discard(existing)
    await runtimes.delete(existing)
    if (existing.hostId && existing.state !== 'removed' && existing.failure !== 'lost')
      await jobs.enqueue(workspaceId, runtimeJobTypes.discard, { runtimeId: existing.id, hostId: existing.hostId })
  }
  const loads = await runtimeHosts.lockLoads(workspaceId, chatId)
  const claimed = await claimedWarmRuntime(unitOfWork, { workspaceId, chatId, id, now }, spyriaAgentImage)
  if (claimed) return claimed
  const placement = placementOf(loads)
  const failure = placement.failure ?? (spyriaAgentImage ? null : 'no_image')
  const runtime: Runtime = {
    workspaceId,
    id: runtimeId(id),
    chatId,
    hostId: failure ? null : (placement.hostId ?? null),
    state: failure ? 'failed' : 'creating',
    failure,
    hostOnline: placement.hostId !== undefined,
    image: spyriaAgentImage ?? '',
    agentVersion: null,
    agentProtocolVersion: null,
    lastActiveAt: now,
    createdAt: now,
    stateChangedAt: now,
  }
  await runtimes.add(runtime)
  if (runtime.state === 'creating') await jobs.enqueue(workspaceId, runtimeJobTypes.create, { runtimeId: runtime.id })
  return runtime
}

const lockedRuntimeOfOpenChat = async ({ runtimes }: UnitOfWork, { workspaceId, chatId }: Input) => {
  const existing = await runtimes.lockByChat(workspaceId, chatId)
  if (await runtimes.isChatArchived(workspaceId, chatId)) throw new RuntimeChatArchived()
  return existing
}

export const ensureRuntimeRunning = ({ transactor, ...placement }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork): Promise<Runtime> => {
    const { runtimes, jobs } = unitOfWork
    const { workspaceId, now } = input
    const existing = await lockedRuntimeOfOpenChat(unitOfWork, input)
    const step = ensureStepOf(existing)
    if (existing && (step === 'none' || isAwaitingHost(existing))) return existing
    if (existing && step !== 'place') {
      const ensured = step === 'start' ? transitioned(existing, 'starting', now) : { ...existing, lastActiveAt: now }
      await runtimes.save(ensured)
      if (step === 'start') await jobs.enqueue(workspaceId, runtimeJobTypes.start, { runtimeId: existing.id })
      return ensured
    }
    return placeRuntime(unitOfWork, input, existing, placement)
  })

export const retryRuntime = ({ transactor, ...placement }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => {
    const existing = await lockedRuntimeOfOpenChat(unitOfWork, input)
    if (!isRetryable(existing)) throw new RetryRefused()
    return placeRuntime(unitOfWork, input, existing, placement)
  })
