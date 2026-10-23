import type { ServerTransaction } from '@rocicorp/zero'
import {
  enqueueJob,
  isWorkspaceDeleted,
  lockDuePurge,
  purgeWorkspaceChunk,
  purgeWorkspaceRows,
  workspaceCleanupOf,
  workspacePurgeTargetsOf,
} from '@spyria/db/server-writes'
import type { Transact } from '@spyria/db/zero-queries'
import { chatId, log, type MemberId, memberId, type WorkspaceId } from '@spyria/kernel'
import { releaseWorkspaceConnectionsOnServer, removeMemberProfileOnServer } from '@spyria/profile/published'
import { removeChatRuntimeOnServer, stopChatRuntimeOnServer } from '@spyria/runtime/published'
import type { DeletedWorkspace } from '../contracts/repositories.ts'
import type { DeletedWorkspaceTransactor } from '../contracts/transactor.ts'
import { workspaceJobTypes } from '../domain/member.ts'

const purgeChunkRows = 5000

const deletedWorkspaceIn = (tx: ServerTransaction, workspaceId: WorkspaceId, actorId: MemberId): DeletedWorkspace => ({
  isDeleted: () => isWorkspaceDeleted(tx, workspaceId),
  lockIfPurgeDue: () => lockDuePurge(tx, workspaceId),
  halt: async () => {
    for (const id of (await workspacePurgeTargetsOf(tx, workspaceId)).runtimeChatIds)
      await stopChatRuntimeOnServer(tx, workspaceId, chatId(id))
  },
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
  cleanup: () => workspaceCleanupOf(tx, workspaceId),
  reportFailedCleanup: async ({ failed }) => {
    log.error({
      event: 'workspace.purge_blocked',
      body: 'A deleted workspace waits for failed cleanup jobs before it is erased',
      attributes: {
        'workspace.id': workspaceId,
        'job.types': failed.map(({ type, count }) => `${type}×${count}`).join(','),
      },
    })
  },
  deleteChunk: () => purgeWorkspaceChunk(tx, workspaceId, purgeChunkRows),
  deleteAll: async () => {
    await purgeWorkspaceRows(tx, workspaceId)
    log.info({ event: 'workspace.purged', body: 'Workspace purged', attributes: { 'workspace.id': workspaceId } })
  },
})

export const createDeletedWorkspaceTransactor = (
  transact: Transact,
  workspaceId: WorkspaceId,
  actorId: MemberId,
): DeletedWorkspaceTransactor => ({
  run: (work) => transact((tx) => work({ deletedWorkspace: deletedWorkspaceIn(tx, workspaceId, actorId) })),
})
