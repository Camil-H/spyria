import type { WorkspacePurgeTransactor } from '../contracts/transactor.ts'
import type { PurgeStage } from '../domain/workspace.ts'

type Dependencies = { transactor: WorkspacePurgeTransactor; cleanupPollMilliseconds: number }

export const purgeWorkspace = (
  { transactor, cleanupPollMilliseconds }: Dependencies,
  { stage }: { stage: PurgeStage },
) =>
  transactor.run(async ({ purge }) => {
    if (!(await purge.isDue())) return undefined
    if (stage === 'release') {
      await purge.release()
      await purge.deleteLater(cleanupPollMilliseconds)
      return undefined
    }
    if (await purge.hasPendingCleanup()) return { retryInMilliseconds: cleanupPollMilliseconds }
    await purge.deleteAll()
    return undefined
  })
