import type { ChatId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { runtimeJobTypes, transitioned } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; now: number }

export const stopChatRuntime = ({ transactor }: Dependencies, { workspaceId, chatId, now }: Input) =>
  transactor.run(async ({ runtimes, jobs }) => {
    const runtime = await runtimes.lockByChat(workspaceId, chatId)
    if (runtime?.state !== 'running') return
    await runtimes.save(transitioned(runtime, 'stopping', now))
    await jobs.enqueue(workspaceId, runtimeJobTypes.stop, { runtimeId: runtime.id })
  })
