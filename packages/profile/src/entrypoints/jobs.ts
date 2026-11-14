import type { Job } from '@spyria/db/zero-queries'
import { log, memberId, type WorkspaceId, workspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import { ToolConnectionsNotChecked } from '../domain/errors.ts'
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
  [profileJobTypes.toolConnectionsSync]: async ({ workspaceId: workspace, payload, transact, isLastAttempt }: Job) => {
    const member = memberContext(workspaceId(workspace), toolConnectionsSyncPayload.parse(payload).memberId)
    await syncToolConnections({ transactor: createTransactingZeroTransactor(transact, member), gateway }).catch(
      (error: unknown) => {
        if (!(isLastAttempt && error instanceof ToolConnectionsNotChecked)) throw error
        log.warn({
          event: 'tool_connections.not_checked',
          body: 'Tool sign-ins kept their stored status after their last check with the gateway failed',
          attributes: { 'workspace.id': workspace, 'member.id': member.userId },
          error,
        })
      },
    )
  },
})
