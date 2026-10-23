import type { Job } from '@spyria/db/zero-queries'
import { memberId, workspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { workspaceJobTypes } from '../domain/member.ts'
import { purgeStages } from '../domain/workspace.ts'
import { createDeletedWorkspaceTransactor } from '../integrations/deleted-workspace.ts'
import { haltWorkspace } from '../operations/halt-workspace.ts'
import { purgeWorkspace } from '../operations/purge-workspace.ts'

const actorId = z.pipe(z.string().check(z.minLength(1)), z.transform(memberId))
const purgePayload = z.object({ stage: z.enum(purgeStages), actorId })
const haltPayload = z.object({ actorId })

export const createWorkspaceJobs = ({
  cleanupPollMilliseconds,
  failedCleanupRetryMilliseconds,
}: {
  cleanupPollMilliseconds: number
  failedCleanupRetryMilliseconds: number
}) => ({
  [workspaceJobTypes.purge]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const { stage, actorId: actor } = purgePayload.parse(payload)
    const transactor = createDeletedWorkspaceTransactor(transact, workspaceId(workspace), actor)
    return purgeWorkspace({ transactor, cleanupPollMilliseconds, failedCleanupRetryMilliseconds }, { stage })
  },
  [workspaceJobTypes.halt]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const { actorId: actor } = haltPayload.parse(payload)
    return haltWorkspace({ transactor: createDeletedWorkspaceTransactor(transact, workspaceId(workspace), actor) })
  },
})
