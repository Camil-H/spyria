import type { ChatId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { haltStepOf, runtimeJobTypes, transitioned } from '../domain/runtime.ts'
import { requestRemoval } from './remove-chat-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; now: number }

export const haltChatRuntime = ({ transactor }: Dependencies, { workspaceId, chatId, now }: Input) =>
  transactor.run(async (unitOfWork) => {
    const runtime = await unitOfWork.runtimes.lockByChat(workspaceId, chatId)
    const step = runtime && haltStepOf(runtime)
    if (!runtime || !step) return
    if (step === 'remove') return requestRemoval(unitOfWork, runtime, now)
    await unitOfWork.runtimes.save(transitioned(runtime, 'stopping', now))
    await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.stop, { runtimeId: runtime.id })
  })
