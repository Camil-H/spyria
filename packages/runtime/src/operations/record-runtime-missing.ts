import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { reconciledStateOf, transitioned } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; hostId: RuntimeHostId; runtimeId: string; now: number }

export const recordRuntimeMissing = ({ transactor }: Dependencies, { workspaceId, hostId, runtimeId, now }: Input) =>
  transactor.run(async ({ runtimes }) => {
    const [runtime] = await runtimes.findByIds(workspaceId, [runtimeId])
    if (runtime?.hostId !== hostId) return
    const current = await runtimes.lock(workspaceId, runtime.id)
    const reconciled = reconciledStateOf(current, 'missing')
    if (reconciled) await runtimes.save({ ...transitioned(current, reconciled, now), lastActiveAt: now })
  })
