import type { Job } from '@spyria/db/zero-queries'
import { memberId, type WorkspaceId, workspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import { profileJobTypes } from '../domain/llm-credential.ts'
import { createTransactingZeroTransactor, memberContext } from '../integrations/zero-transactor.ts'
import { runGatewaySync } from '../operations/sync-member-gateway-key.ts'
import { syncToolConnections } from '../operations/tool-connections.ts'

const id = z.string().check(z.minLength(1))
const gatewaySyncPayload = z.object({
  memberId: z.pipe(id, z.transform(memberId)),
  key: z.optional(z.object({ provider: id, id })),
  isLeaving: z.optional(z.boolean()),
})
const toolServerRemovalPayload = z.object({ gatewayName: id })
const toolConnectionsSyncPayload = z.object({ memberId: z.pipe(id, z.transform(memberId)) })

export const createProfileJobs = (
  gateway: LlmGateway & ToolGateway,
  onToolGrantsChanged: (workspace: WorkspaceId) => void = () => {},
) => ({
  [profileJobTypes.gatewaySync]: async ({ workspaceId: workspace, payload, transact }: Job) => {
    const job = gatewaySyncPayload.parse(payload)
    const transactor = createTransactingZeroTransactor(transact, memberContext(workspaceId(workspace), job.memberId))
    await runGatewaySync({ transactor, gateway }, job)
    onToolGrantsChanged(workspaceId(workspace))
  },
  [profileJobTypes.toolServerRemoval]: ({ payload }: Job) =>
    gateway.removeToolServer(toolServerRemovalPayload.parse(payload).gatewayName),
  [profileJobTypes.toolConnectionsSync]: ({ workspaceId: workspace, payload, transact }: Job) =>
    syncToolConnections({
      transactor: createTransactingZeroTransactor(
        transact,
        memberContext(workspaceId(workspace), toolConnectionsSyncPayload.parse(payload).memberId),
      ),
      gateway,
    }),
})
