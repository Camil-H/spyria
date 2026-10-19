import type { ChatId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isTouchDue } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; now: number }

export const touchRuntime = ({ transactor }: Dependencies, { workspaceId, chatId, now }: Input) =>
  transactor.run(async ({ runtimes }) => {
    const seen = await runtimes.findByChat(workspaceId, chatId)
    if (!seen || !isTouchDue(seen, now)) return
    const runtime = await runtimes.lock(workspaceId, seen.id)
    if (isTouchDue(runtime, now)) await runtimes.save({ ...runtime, lastActiveAt: now })
  })
