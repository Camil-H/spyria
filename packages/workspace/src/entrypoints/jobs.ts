import type { Job } from '@spyria/db/zero-queries'
import { memberId, workspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import { workspaceJobTypes } from '../domain/member.ts'
import { purgeStages } from '../domain/workspace.ts'
import { createWorkspacePurgeTransactor } from '../integrations/workspace-purge.ts'
import { purgeWorkspace } from '../operations/purge-workspace.ts'

const purgePayload = z.object({
  stage: z.enum(purgeStages),
  actorId: z.pipe(z.string().check(z.minLength(1)), z.transform(memberId)),
})

export const createWorkspaceJobs = ({ cleanupPollMilliseconds }: { cleanupPollMilliseconds: number }) => ({
  [workspaceJobTypes.purge]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const { stage, actorId } = purgePayload.parse(payload)
    const transactor = createWorkspacePurgeTransactor(transact, workspaceId(workspace), actorId)
    return purgeWorkspace({ transactor, cleanupPollMilliseconds }, { stage })
  },
})
