import type { Transact, ZeroContext } from '@spyria/db/zero-queries'
import { type MemberId, memberId, type WorkspaceId } from '@spyria/kernel'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import { Secret } from '../domain/secret.ts'
import { toolConsentChannel } from '../integrations/http-tool-connections.ts'
import { createTransactingZeroTransactor, memberContext } from '../integrations/zero-transactor.ts'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { grantMemberTools } from '../operations/grant-tools.ts'
import { toolKeyValueOf, virtualKeyValueOf } from '../operations/sync-member-gateway-key.ts'
import {
  availableTools,
  disconnectTool,
  flagToolConnection,
  refreshToolConnection,
  startToolConnection,
  toolCallAccess,
  toolServerNameOf,
} from '../operations/tool-connections.ts'
import {
  addWorkspaceConnection,
  allowConnectionTools,
  editWorkspaceConnection,
  removeWorkspaceConnection,
  restrictConnectionMember,
} from '../operations/workspace-connections.ts'

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

export const addLlmCredentialFromRequest = (
  transact: Transact,
  context: ZeroContext,
  body: unknown,
  gateway: LlmGateway & ToolGateway,
) => {
  const { provider, secret } = (body ?? {}) as Record<string, unknown>
  return addLlmCredential(
    { transactor: createTransactingZeroTransactor(transact, context), gateway },
    {
      id: crypto.randomUUID(),
      provider: textOf(provider),
      secret: new Secret(textOf(secret)),
    },
  )
}

export const createMemberKeyReader =
  (transact: Transact, gateway: LlmGateway) => (workspace: WorkspaceId, member: MemberId) =>
    virtualKeyValueOf({
      transactor: createTransactingZeroTransactor(transact, memberContext(workspace, member)),
      gateway,
    })

const toolActions = { connect: startToolConnection, refresh: refreshToolConnection, disconnect: disconnectTool }

export const toolConnectionFromRequest = (
  transact: Transact,
  context: ZeroContext,
  gateway: LlmGateway & ToolGateway,
  tool: string,
  action: string,
) => {
  const act = toolActions[action as keyof typeof toolActions]
  return act?.({ transactor: createTransactingZeroTransactor(transact, context), gateway }, { tool })
}

export const availableToolsFromRequest = async (gateway: ToolGateway) => ({
  available: await availableTools({ gateway }),
})

export const createToolCallOwnerAccess = (transact: Transact, gateway: LlmGateway & ToolGateway) => {
  const dependenciesOf = (workspace: WorkspaceId, member: MemberId) => ({
    transactor: createTransactingZeroTransactor(transact, memberContext(workspace, member)),
    gateway,
  })
  return {
    keyOf: (workspace: WorkspaceId, member: MemberId) => toolKeyValueOf(dependenciesOf(workspace, member)),
    grantMemberTools: (workspace: WorkspaceId, member: MemberId) =>
      grantMemberTools(dependenciesOf(workspace, member), { workspaceId: workspace, memberId: member }),
    flagToolConnection: (workspace: WorkspaceId, member: MemberId, tool: string) =>
      flagToolConnection(dependenciesOf(workspace, member), { tool }),
    toolCallAccess: (workspace: WorkspaceId, owner: MemberId, prompter: MemberId, toolName: string) =>
      toolCallAccess(dependenciesOf(workspace, owner), { prompterId: prompter, toolName }),
    serverNameOf: (workspace: WorkspaceId, owner: MemberId, server: string) =>
      toolServerNameOf(dependenciesOf(workspace, owner), { tool: server }),
  }
}

const textListOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const secretHeaderOf = (value: unknown) => {
  if (value === null) return null
  const { name, value: secret } = (value ?? {}) as Record<string, unknown>
  return value === undefined ? undefined : { name: textOf(name), value: textOf(secret) }
}

export const workspaceConnectionFromRequest = (
  transact: Transact,
  context: ZeroContext,
  gateway: ToolGateway,
  action: string,
  connectionId: string,
  body: unknown,
) => {
  const fields = (body ?? {}) as Record<string, unknown>
  const dependencies = { transactor: createTransactingZeroTransactor(transact, context), gateway }
  const target = { workspaceId: context.workspaceId, connectionId }
  const connection = {
    name: textOf(fields.name),
    url: textOf(fields.url),
    secretHeader: secretHeaderOf(fields.secretHeader),
  }
  const actions: Record<string, () => Promise<unknown>> = {
    add: () => addWorkspaceConnection(dependencies, { ...target, ...connection }),
    edit: () => editWorkspaceConnection(dependencies, { ...target, ...connection }),
    remove: () => removeWorkspaceConnection(dependencies, target),
    tools: () => allowConnectionTools(dependencies, { ...target, allowedTools: textListOf(fields.allowedTools) }),
    restrict: () =>
      restrictConnectionMember(dependencies, {
        ...target,
        memberId: memberId(textOf(fields.memberId)),
        allowedTools: fields.allowedTools === null ? null : textListOf(fields.allowedTools),
      }),
  }
  return actions[action]?.() ?? Promise.resolve()
}

export const toolConsentCallbackPath = '/gateway-oauth/api/oauth/callback'

export const toolConsentPageFromRequest = async (gateway: ToolGateway, callbackQuery: string) => {
  const connected = await gateway.finishToolConsent(callbackQuery).catch(() => false)
  return `<!doctype html><meta charset="utf-8"><title>Spyria</title>
<p>${connected ? 'Connected' : 'The connection failed'}. You can close this window.</p>
<script>new BroadcastChannel('${toolConsentChannel}').postMessage(${JSON.stringify({ connected })});close()</script>`
}
