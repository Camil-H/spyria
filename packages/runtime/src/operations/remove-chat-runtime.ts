import type { ChatId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { type Runtime, removalStepOf, runtimeJobs, transitioned } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; now: number }

export const requestRemoval = async ({ runtimes, secrets, jobs }: UnitOfWork, runtime: Runtime, now: number) => {
  const step = removalStepOf(runtime)
  if (!step) return
  await runtimes.save(transitioned(runtime, step, now))
  if (step === 'removed') await secrets.discard(runtime)
  else await jobs.enqueue(runtime.workspaceId, runtimeJobs.remove, { runtimeId: runtime.id })
}

export const removeChatRuntime = ({ transactor }: Dependencies, { workspaceId, chatId, now }: Input) =>
  transactor.run(async (unitOfWork) => {
    const runtime = await unitOfWork.runtimes.lockByChat(workspaceId, chatId)
    if (runtime) await requestRemoval(unitOfWork, runtime, now)
  })
