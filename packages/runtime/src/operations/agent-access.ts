import type { ChatId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { RuntimeNotFound } from '../domain/errors.ts'
import { locationOf } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }
type ChatRuntime = { workspaceId: WorkspaceId; chatId: ChatId }

export const readAgentAccess = ({ transactor }: Dependencies, { workspaceId, chatId }: ChatRuntime) =>
  transactor.run(async ({ runtimes, secrets }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    const sandbox = runtime?.state === 'running' ? locationOf(runtime) : undefined
    if (!runtime || !sandbox) return undefined
    const apiKey = await secrets.valueOf(runtime, 'apiKey')
    const llmToken = await secrets.valueOf(runtime, 'llmToken')
    if (!apiKey || !llmToken) return undefined
    return { sandbox, apiKey, llmToken, conversationId: (await runtimes.agentConversationOf(runtime)) ?? null }
  })

export const rememberAgentConversation = (
  { transactor }: Dependencies,
  { workspaceId, chatId, conversationId }: ChatRuntime & { conversationId: string },
) =>
  transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.findByChat(workspaceId, chatId)
    if (!runtime) throw new RuntimeNotFound(chatId)
    return runtimes.rememberAgentConversation(runtime, conversationId)
  })
