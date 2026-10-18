import type { ChatId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { hashSecret, newSecretToken } from '../domain/claim.ts'
import { RuntimeNotFound } from '../domain/errors.ts'
import { locationOf } from '../domain/runtime.ts'
import { withExpiredSignIn } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type ChatRuntime = { workspaceId: WorkspaceId; chatId: ChatId }

export const readAgentAccess = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes, runtimeHosts, secrets }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    const sandbox = runtime?.state === 'running' && runtime.hostOnline ? locationOf(runtime) : undefined
    if (!runtime || !sandbox) return undefined
    const apiKey = await secrets.valueOf(runtime, 'apiKey')
    if (!apiKey) return undefined
    const capacity = (await runtimeHosts.find(workspaceId, sandbox.hostId))?.capacity
    return {
      sandbox,
      apiKey,
      conversationId: (await runtimes.agentConversationOf(runtime)) ?? null,
      signedIn: capacity?.signedIn ?? [],
    }
  })

export const expireSignIn = (
  { transactor }: Dependencies,
  { workspaceId, chatId, tool }: ChatRuntime & { tool: string },
) =>
  transactor.run(async ({ runtimes, runtimeHosts }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    const host = runtime?.hostId && (await runtimeHosts.find(workspaceId, runtime.hostId))
    if (host?.capacity) await runtimeHosts.save({ ...host, capacity: withExpiredSignIn(host.capacity, tool) })
  })

export const isRuntimeWaitingOnHost = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    return runtime?.state === 'running' && !runtime.hostOnline
  })

export const issueAgentLlmToken = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes, secrets }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    if (!runtime) throw new RuntimeNotFound(chatId)
    const token = newSecretToken()
    await secrets.keep(runtime, 'llmTokenHash', await hashSecret(token))
    return token
  })

export const findLlmTokenChat = async (
  { transactor }: Dependencies,
  { workspaceId, hostId, token }: { workspaceId: WorkspaceId; hostId: RuntimeHostId; token: string },
) => {
  const hash = await hashSecret(token)
  return transactor.run(({ runtimes }) => runtimes.chatOfLlmTokenHash(workspaceId, hostId, hash))
}

export const rememberAgentConversation = (
  { transactor }: Dependencies,
  { workspaceId, chatId, conversationId }: ChatRuntime & { conversationId: string },
) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    if (!runtime) throw new RuntimeNotFound(chatId)
    return runtimes.rememberAgentConversation(runtime, conversationId)
  })

export const forgetAgentConversation = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    if (runtime) await runtimes.forgetAgentConversation(runtime)
  })

export const readWorkspaceSnapshot = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    return runtime && runtimes.workspaceSnapshotOf(runtime)
  })

export const keepWorkspaceSnapshot = (
  { transactor }: Dependencies,
  { workspaceId, chatId, snapshot }: ChatRuntime & { snapshot: string },
) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    if (runtime) await runtimes.keepWorkspaceSnapshot(runtime, snapshot)
  })

export const listHostChats = (
  { transactor }: Dependencies,
  { workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId },
) =>
  transactor.run(async ({ runtimes }) =>
    (await runtimes.lockWaitingOnHost(workspaceId, hostId)).map((runtime) => runtime.chatId),
  )
