import type { Transact, ZeroContext } from '@spyria/db/zero-queries'
import type { AccessLevel, MemberId, WorkspaceId } from '@spyria/kernel'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import { Secret } from '../domain/secret.ts'
import type { ConnectionSignIn } from '../domain/workspace-connection.ts'
import { toolConsentChannel } from '../integrations/http-tool-connections.ts'
import { createTransactingZeroTransactor, memberContext } from '../integrations/zero-transactor.ts'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { isModelAllowed } from '../operations/ai-providers.ts'
import { grantMemberTools } from '../operations/grant-tools.ts'
import { toolKeyValueOf, virtualKeyValueOf } from '../operations/sync-member-gateway-key.ts'
import {
  catalogueServersOf,
  checkToolConnections,
  disconnectTool,
  flagToolConnection,
  refreshToolConnection,
  startToolConnection,
  toolCallPolicy,
  toolServerNameOf,
} from '../operations/tool-connections.ts'
import {
  addWorkspaceConnection,
  editWorkspaceConnection,
  finishWorkspaceConnection,
  removeWorkspaceConnection,
  reviewConnectionTools,
  setConnectionAccess,
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

export const createModelGuard =
  (transact: Transact) => (workspace: WorkspaceId, member: MemberId, model: string | undefined) =>
    isModelAllowed(
      { transactor: createTransactingZeroTransactor(transact, memberContext(workspace, member)) },
      { model },
    )

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

export const checkToolConnectionsFromRequest = (transact: Transact, context: ZeroContext, gateway: ToolGateway) =>
  checkToolConnections({ transactor: createTransactingZeroTransactor(transact, context), gateway })

export const createToolCallAccess = (transact: Transact, gateway: LlmGateway & ToolGateway) => {
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
    toolCallPolicy: (workspace: WorkspaceId, owner: MemberId, prompter: MemberId, toolName: string) =>
      toolCallPolicy(dependenciesOf(workspace, prompter), { ownerId: owner, prompterId: prompter, toolName }),
    serverNameOf: (workspace: WorkspaceId, owner: MemberId, server: string) =>
      toolServerNameOf(dependenciesOf(workspace, owner), { tool: server }),
    catalogueServersOf: (workspace: WorkspaceId, member: MemberId) =>
      catalogueServersOf(dependenciesOf(workspace, member)),
  }
}

const recordOf = (value: unknown) => (typeof value === 'object' && value !== null ? value : {})
const markingsOf = (value: unknown) =>
  (Array.isArray(value) ? value : []).map((marking) => {
    const { name, readOnly } = recordOf(marking) as Record<string, unknown>
    return { name: textOf(name), readOnly: readOnly === true }
  })
const toolChangesOf = (value: unknown) =>
  Object.fromEntries(Object.entries(recordOf(value)).filter(([, isAllowed]) => typeof isAllowed === 'boolean'))
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
  const signIn = textOf(fields.signIn) as ConnectionSignIn
  const actions: Record<string, () => Promise<unknown>> = {
    add: () => addWorkspaceConnection(dependencies, { ...target, ...connection, signIn }),
    finish: () => finishWorkspaceConnection(dependencies, target),
    edit: () => editWorkspaceConnection(dependencies, { ...target, ...connection }),
    remove: () => removeWorkspaceConnection(dependencies, target),
    review: () => reviewConnectionTools(dependencies, { ...target, markings: markingsOf(fields.markings) }),
    access: () =>
      setConnectionAccess(dependencies, {
        ...target,
        roleId: textOf(fields.roleId),
        level: fields.level === null ? null : (textOf(fields.level) as AccessLevel),
        toolChanges: toolChangesOf(fields.toolChanges),
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
