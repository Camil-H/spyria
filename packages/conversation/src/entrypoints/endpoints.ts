import {
  chatContextTokens,
  finishedToolCallEventOf,
  isWorkspaceHostOnline,
  lastAdapterModelsOf,
  listedModelsOf,
  memberModelsOf,
} from '@hq/db/server-writes'
import type { ZeroContext } from '@hq/db/zero-queries'
import { chatModelsOf, type Model, routableModelNames, withPricesOf } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { textOf } from '../domain/agent-steps.ts'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`

export const readCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) => {
  const event = await finishedToolCallEventOf(tx, context.workspaceId, chatId, stepId)
  const projection = event && agentProjectionOf(event as AgentEvent)
  return projection?.type === 'observation' ? textOf(projection.observation?.content) : ''
}

export const chatRoutingPathOf = (chatId: string) => `/api/chats/${chatId}/routing`
export type ChatRoutingRead = {
  reachableModels: Model[]
  modelNames: Record<string, string>
  contextTokens: number | null
  adapterModels: { currentModelId: string | null; available: { id: string; name: string }[] }
  hqRuntimeAvailable: boolean
}

export const readChatRouting = async (
  transact: <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>,
  { workspaceId, userId }: ZeroContext,
  chatId: string,
): Promise<ChatRoutingRead> => {
  const { contextTokens, reachable, adapterModels, hqRuntimeAvailable } = await transact(async (tx) => ({
    contextTokens: await chatContextTokens(tx, workspaceId, chatId),
    reachable: chatModelsOf((await memberModelsOf(tx, workspaceId, userId)) ?? []),
    adapterModels: await lastAdapterModelsOf(tx, workspaceId, chatId),
    hqRuntimeAvailable: await isWorkspaceHostOnline(tx, workspaceId),
  }))
  return {
    reachableModels: withPricesOf(reachable, listedModelsOf()),
    modelNames: routableModelNames(),
    contextTokens,
    adapterModels: {
      currentModelId: adapterModels?.isThisChat ? adapterModels.currentModelId : null,
      available: adapterModels?.availableModels.map(({ model_id, name }) => ({ id: model_id, name })) ?? [],
    },
    hqRuntimeAvailable,
  }
}

export const chatQuestionPathOf = (chatId: string, questionId: string) => `/api/chats/${chatId}/questions/${questionId}`
export const chatPlanModePathOf = (chatId: string) => `/api/chats/${chatId}/plan-mode`

const questionAnswer = z.union([
  z.object({ approve: z.boolean() }),
  z.object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    free: z.optional(z.record(z.string(), z.string())),
  }),
])
const planMode = z.object({ enabled: z.boolean() })

export const questionAnswerOf = (body: unknown) => questionAnswer.safeParse(body).data
export const planModeOf = (body: unknown) => planMode.safeParse(body).data
