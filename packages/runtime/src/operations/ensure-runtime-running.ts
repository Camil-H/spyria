import { type ChatId, runtimeId, type WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { newSecretToken } from '../domain/claim.ts'
import { RetryRefused } from '../domain/errors.ts'
import {
  ensureStepOf,
  isAwaitingHost,
  isRetryable,
  placementOf,
  type Runtime,
  runtimeJobs,
  transitioned,
} from '../domain/runtime.ts'
import { agentServerImage } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; id: string; now: number }

const placeRuntime = async (
  { runtimes, runtimeHosts, secrets, jobs }: UnitOfWork,
  { workspaceId, chatId, id, now }: Input,
  existing: Runtime | undefined,
) => {
  if (existing) {
    await secrets.discard(existing)
    await runtimes.delete(existing)
  }
  const placement = placementOf(await runtimeHosts.lockLoads(workspaceId, chatId))
  const runtime: Runtime = {
    workspaceId,
    id: runtimeId(id),
    chatId,
    hostId: placement.hostId ?? null,
    state: placement.hostId ? 'creating' : 'failed',
    failure: placement.failure ?? null,
    hostOnline: placement.hostId !== undefined,
    image: agentServerImage,
    lastActiveAt: now,
    createdAt: now,
    stateChangedAt: now,
  }
  await runtimes.add(runtime)
  if (runtime.state === 'creating') {
    await secrets.keep(runtime, 'apiKey', newSecretToken())
    await jobs.enqueue(workspaceId, runtimeJobs.create, { runtimeId: runtime.id })
  }
  return runtime
}

export const ensureRuntimeRunning = ({ transactor }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork): Promise<Runtime> => {
    const { runtimes, jobs } = unitOfWork
    const { workspaceId, chatId, now } = input
    const existing = await runtimes.lockByChat(workspaceId, chatId)
    const step = ensureStepOf(existing)
    if (existing && (step === 'none' || isAwaitingHost(existing))) return existing
    if (existing && step !== 'place') {
      const ensured = step === 'start' ? transitioned(existing, 'starting', now) : { ...existing, lastActiveAt: now }
      await runtimes.save(ensured)
      if (step === 'start') await jobs.enqueue(workspaceId, runtimeJobs.start, { runtimeId: existing.id })
      return ensured
    }
    return placeRuntime(unitOfWork, input, existing)
  })

export const retryRuntime = ({ transactor }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => {
    const existing = await unitOfWork.runtimes.lockByChat(input.workspaceId, input.chatId)
    if (!isRetryable(existing)) throw new RetryRefused()
    return placeRuntime(unitOfWork, input, existing)
  })
