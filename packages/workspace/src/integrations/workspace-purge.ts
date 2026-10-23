import type { ServerTransaction } from '@rocicorp/zero'
import {
  enqueueJob,
  hasPendingWorkspaceJobs,
  isWorkspacePurgeDue,
  purgeWorkspaceRows,
  workspacePurgeTargetsOf,
} from '@spyria/db/server-writes'
import type { Transact } from '@spyria/db/zero-queries'
import { chatId, log, type MemberId, memberId, type WorkspaceId } from '@spyria/kernel'
import { releaseWorkspaceConnectionsOnServer, removeMemberProfileOnServer } from '@spyria/profile/published'
import { removeChatRuntimeOnServer } from '@spyria/runtime/published'
import type { WorkspacePurge } from '../contracts/repositories.ts'
import type { WorkspacePurgeTransactor } from '../contracts/transactor.ts'
import { workspaceJobTypes } from '../domain/member.ts'

const purgeIn = (tx: ServerTransaction, workspaceId: WorkspaceId, actorId: MemberId): WorkspacePurge => ({
  isDue: () => isWorkspacePurgeDue(tx, workspaceId),
  release: async () => {
    const { memberIds, runtimeChatIds } = await workspacePurgeTargetsOf(tx, workspaceId)
    for (const id of runtimeChatIds) await removeChatRuntimeOnServer(tx, workspaceId, chatId(id))
    for (const id of memberIds) await removeMemberProfileOnServer(tx, workspaceId, memberId(id))
    await releaseWorkspaceConnectionsOnServer(tx, workspaceId, actorId)
  },
  deleteLater: async (delayMilliseconds) => {
    await enqueueJob(tx, {
      workspaceId,
      type: workspaceJobTypes.purge,
      payload: { stage: 'delete', actorId },
      delayMilliseconds,
    })
  },
  hasPendingCleanup: () => hasPendingWorkspaceJobs(tx, workspaceId, workspaceJobTypes.purge),
  deleteAll: async () => {
    await purgeWorkspaceRows(tx, workspaceId)
    log.info({ event: 'workspace.purged', body: 'Workspace purged', attributes: { 'workspace.id': workspaceId } })
  },
})

export const createWorkspacePurgeTransactor = (
  transact: Transact,
  workspaceId: WorkspaceId,
  actorId: MemberId,
): WorkspacePurgeTransactor => ({
  run: (work) => transact((tx) => work({ purge: purgeIn(tx, workspaceId, actorId) })),
})
