import type { Job } from '@hq/db/zero-queries'
import { memberId, workspaceId } from '@hq/kernel'
import { z } from 'zod/mini'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import { profileJobTypes } from '../domain/llm-credential.ts'
import { createTransactingZeroTransactor, memberContext } from '../integrations/zero-transactor.ts'
import { runGatewaySync } from '../operations/sync-member-gateway-key.ts'

const id = z.string().check(z.minLength(1))
const gatewaySyncPayload = z.object({
  memberId: z.pipe(id, z.transform(memberId)),
  key: z.object({ provider: id, id }),
})

export const createProfileJobs = (gateway: LlmGateway & ToolGateway) => ({
  [profileJobTypes.gatewaySync]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const job = gatewaySyncPayload.parse(payload)
    const transactor = createTransactingZeroTransactor(transact, memberContext(workspaceId(workspace), job.memberId))
    return runGatewaySync({ transactor, gateway }, { ...job, workspaceId: workspaceId(workspace) })
  },
})
