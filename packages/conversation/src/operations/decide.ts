import { classifierModelOf, type MemberId, type Model, withPricesOf } from '@hq/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import { answersOf, decisionRequestOf, type Questions } from '../domain/decisions.ts'
import type { AgentDependencies } from './agent-turn.ts'

export const digestOf = async (value: unknown) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

export const routingUnavailableOf = (failure?: string) =>
  failure ? `routing unavailable: ${failure}` : 'routing unavailable'

export const decide = async (
  { classifier }: Pick<AgentDependencies, 'classifier'>,
  {
    models,
    ...call
  }: {
    chat: AgentChat
    prompterId: MemberId
    ownerId: MemberId | null
    models: readonly Model[]
    state: string
    questions: Questions
  },
) => {
  if (!classifier) return undefined
  const model = classifierModelOf(withPricesOf(models, classifier.listedModels()))
  if (!model) return undefined
  const request = decisionRequestOf(model, call.state, call.questions)
  const reply = await classifier.classify({ ...call, model, request })
  const answers = 'body' in reply ? answersOf(model, call.questions, reply.body) : undefined
  const failure = 'failure' in reply ? reply.failure : answers ? undefined : 'unreadable answers'
  if (failure) console.warn(`Routing of chat ${call.chat.chatId} fell back without the classifier: ${failure}`)
  const usage = 'body' in reply ? reply : { inputTokens: 0, outputTokens: 0 }
  return {
    answers,
    failure,
    costMicros: Math.round(
      usage.inputTokens * (model.dollarsPerMillionInputTokens ?? 0) +
        usage.outputTokens * (model.dollarsPerMillionOutputTokens ?? 0),
    ),
    inputsDigest: await digestOf(request),
  }
}
