import { type ChatId, runtimeId, type WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { newSecretToken } from '../domain/claim.ts'
import { ensureStepOf, placementOf, type Runtime, runtimeJobs, transitioned } from '../domain/runtime.ts'
import { agentServerImage } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; id: string; now: number }

export const ensureRuntimeRunning = ({ transactor }: Dependencies, { workspaceId, chatId, id, now }: Input) =>
  transactor.run(async ({ runtimes, runtimeHosts, apiKeys, jobs }): Promise<Runtime> => {
    const existing = await runtimes.lockByChat(workspaceId, chatId)
    const step = ensureStepOf(existing)
    if (existing && step === 'none') return existing
    if (existing && step !== 'place') {
      const ensured = step === 'start' ? transitioned(existing, 'starting', now) : { ...existing, lastActiveAt: now }
      await runtimes.save(ensured)
      if (step === 'start') await jobs.enqueue(workspaceId, runtimeJobs.start, { runtimeId: existing.id })
      return ensured
    }
    if (existing) await runtimes.delete(existing)
    const placement = placementOf(await runtimeHosts.lockLoads(workspaceId))
    const runtime: Runtime = {
      workspaceId,
      id: runtimeId(id),
      chatId,
      hostId: placement.hostId ?? null,
      state: placement.hostId ? 'creating' : 'failed',
      failure: placement.failure ?? null,
      image: agentServerImage,
      lastActiveAt: now,
      createdAt: now,
      stateChangedAt: now,
    }
    await runtimes.add(runtime)
    if (runtime.state === 'creating') {
      await apiKeys.keep(runtime, newSecretToken())
      await jobs.enqueue(workspaceId, runtimeJobs.create, { runtimeId: runtime.id })
    }
    return runtime
  })
