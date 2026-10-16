import type { Job, Transact, ZeroContext } from '@hq/db/zero-queries'
import { type MemberId, memberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import { z } from 'zod/mini'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { Secret } from '../domain/secret.ts'
import { toolConsentChannel } from '../integrations/http-tool-connections.ts'
import { createZeroTransactor, profileJobTypes } from '../integrations/zero-transactor.ts'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { runGatewaySync, virtualKeyValueOf } from '../operations/sync-member-gateway-key.ts'
import {
  availableTools,
  disconnectTool,
  flagToolConnection,
  grantAvailableTools,
  refreshToolConnection,
  startToolConnection,
} from '../operations/tool-connections.ts'

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')
const id = z.string().check(z.minLength(1))
const gatewaySyncPayload = z.object({
  memberId: z.pipe(id, z.transform(memberId)),
  key: z.object({ provider: id, id }),
})

const transactorAs = (transact: Transact, context: ZeroContext): ProfileTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx, context).run(work)),
})
const memberContext = (workspace: WorkspaceId, member: MemberId): ZeroContext => ({
  workspaceId: workspace,
  userId: member,
  role: 'member',
})

export const addLlmCredentialFromRequest = (
  transact: Transact,
  context: ZeroContext,
  body: unknown,
  gateway: LlmGateway,
) => {
  const { provider, secret } = (body ?? {}) as Record<string, unknown>
  return addLlmCredential(
    { transactor: transactorAs(transact, context), gateway },
    {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      memberId: context.userId,
      provider: textOf(provider),
      secret: new Secret(textOf(secret)),
    },
  )
}

export const createProfileJobs = (gateway: LlmGateway) => ({
  [profileJobTypes.gatewaySync]: ({ workspaceId: workspace, payload, transact }: Job) => {
    const job = gatewaySyncPayload.parse(payload)
    const transactor = transactorAs(transact, memberContext(workspaceId(workspace), job.memberId))
    return runGatewaySync({ transactor, gateway }, { ...job, workspaceId: workspaceId(workspace) })
  },
})

export const createMemberKeyReader =
  (transact: Transact, gateway: LlmGateway) => (workspace: WorkspaceId, member: MemberId) =>
    virtualKeyValueOf(
      { transactor: transactorAs(transact, memberContext(workspace, member)), gateway },
      { workspaceId: workspace, memberId: member },
    )

const toolActions = { connect: startToolConnection, refresh: refreshToolConnection, disconnect: disconnectTool }

export const toolConnectionFromRequest = (
  transact: Transact,
  context: ZeroContext,
  gateway: ToolGateway,
  tool: string,
  action: string,
) => {
  const act = toolActions[action as keyof typeof toolActions]
  return act?.(
    { transactor: transactorAs(transact, context), gateway },
    { workspaceId: context.workspaceId, memberId: context.userId, tool },
  )
}

export const availableToolsFromRequest = async (gateway: ToolGateway) => ({
  available: await availableTools({ gateway }),
})

export const createToolCallOwnerAccess = (transact: Transact, gateway: ToolGateway) => {
  const dependenciesOf = (workspace: WorkspaceId, member: MemberId) => ({
    transactor: transactorAs(transact, memberContext(workspace, member)),
    gateway,
  })
  return {
    grantAvailableTools: (workspace: WorkspaceId, member: MemberId) =>
      grantAvailableTools(dependenciesOf(workspace, member), { workspaceId: workspace, memberId: member }),
    flagToolConnection: (workspace: WorkspaceId, member: MemberId, tool: string) =>
      flagToolConnection(dependenciesOf(workspace, member), { workspaceId: workspace, memberId: member, tool }),
  }
}

export const toolConsentCallbackPath = '/gateway-oauth/api/oauth/callback'

export const toolConsentPageFromRequest = async (gateway: ToolGateway, callbackQuery: string) => {
  const connected = await gateway.finishToolConsent(callbackQuery).catch(() => false)
  return `<!doctype html><meta charset="utf-8"><title>HQ</title>
<p>${connected ? 'Connected' : 'The connection failed'}. You can close this window.</p>
<script>new BroadcastChannel('${toolConsentChannel}').postMessage(${JSON.stringify({ connected })});close()</script>`
}
