import { chatModelsOf, type Model, type ModelTier, nearestModelOf } from '@hq/kernel'
import { type Answers, confidenceThreshold } from './decisions.ts'

const efforts = ['small', 'medium', 'large']

export const delegateTool = {
  name: 'delegate',
  description: 'Hand a self-contained task to a subagent; it shares your workspace and returns its final answer.',
  inputSchema: {
    type: 'object',
    required: ['task', 'effort'],
    properties: {
      task: { type: 'string' },
      effort: { type: 'string', enum: efforts },
      resume: { type: 'string', description: 'The id of a task that is still running' },
    },
  },
}

export const effortHintOf = (effort: unknown) => (efforts.includes(String(effort)) ? String(effort) : 'medium')

export const delegationStateOf = (task: string, effortHint: string, mode: string | null) =>
  `Chat mode: ${mode ?? 'non-dev'}\nSubagent task (effort hint: ${effortHint}):\n${task}`

export const delegationChoiceOf = (reachable: readonly Model[], answers: Answers | undefined) => {
  const tier = answers?.tier
  if (!tier || tier.confidence < confidenceThreshold) return undefined
  const chatModels = chatModelsOf(reachable)
  const nearestTier = nearestModelOf(chatModels, tier.value as ModelTier)?.tier
  const model = chatModels
    .filter((candidate) => candidate.tier === nearestTier)
    .toSorted(
      (first, second) => (second.dollarsPerMillionOutputTokens ?? 0) - (first.dollarsPerMillionOutputTokens ?? 0),
    )[0]
  return model && { model: model.id, effort: answers?.effort?.value ?? null, reason: `classified ${tier.value}` }
}

export const subagentFailureOf = (modelName: string) => `The subagent on ${modelName} stopped with an error`
