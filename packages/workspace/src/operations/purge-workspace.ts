import type { DeletedWorkspaceTransactor } from '../contracts/transactor.ts'
import type { PurgeStage } from '../domain/workspace.ts'

type Dependencies = {
  transactor: DeletedWorkspaceTransactor
  cleanupPollMilliseconds: number
  failedCleanupRetryMilliseconds: number
}

export const purgeWorkspace = (
  { transactor, cleanupPollMilliseconds, failedCleanupRetryMilliseconds }: Dependencies,
  { stage }: { stage: PurgeStage },
) =>
  transactor.run(async ({ deletedWorkspace }) => {
    if (!(await deletedWorkspace.lockIfPurgeDue())) return undefined
    if (stage === 'release') {
      await deletedWorkspace.release()
      await deletedWorkspace.deleteLater(cleanupPollMilliseconds)
      return undefined
    }
    const cleanup = await deletedWorkspace.cleanup()
    if (cleanup.isPending) return { retryInMilliseconds: cleanupPollMilliseconds }
    if (cleanup.failed.length > 0) {
      await deletedWorkspace.reportFailedCleanup(cleanup)
      return { retryInMilliseconds: failedCleanupRetryMilliseconds }
    }
    if ((await deletedWorkspace.deleteChunk()) > 0) return { retryInMilliseconds: 0 }
    await deletedWorkspace.deleteAll()
    return undefined
  })
