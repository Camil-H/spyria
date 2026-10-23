import type { MemberId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireAdmin } from '../domain/member.ts'
import { workspaceDeletionGraceMilliseconds } from '../domain/workspace.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { actorId: MemberId; now: number }

export const deleteWorkspace = ({ transactor }: Dependencies, { actorId, now }: Input) =>
  transactor.run(async ({ memberships, workspaces, chats, chatRuntimes, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId))
    const purgeAt = now + workspaceDeletionGraceMilliseconds
    await workspaces.scheduleDeletion({ purgeAt, actorId })
    for (const chat of await chats.listRuntimeChats()) await chatRuntimes.stop(chat.id)
    await workspaceEvents.record({
      type: 'workspace.deleted',
      actorId,
      payload: { purgeAt: new Date(purgeAt).toISOString() },
    })
  })
