import { chatModelsOf, type Model, type ModelTier, nearestModelOf, routableModelOf } from '@hq/kernel'
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
      model: {
        type: 'string',
        description:
          'A model name or a tier (large, medium, small), only when the user explicitly asked for a model or a tier',
      },
    },
  },
}
export const awaitTaskTool = {
  name: 'await_task',
  description:
    'Wait for a delegated task that is still running; returns its final answer, or that it is still running.',
  inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
}
export const routerTools = [delegateTool, awaitTaskTool]

export const effortHintOf = (effort: unknown) => (efforts.includes(String(effort)) ? String(effort) : 'medium')

export const delegationStateOf = (task: string, effortHint: string, mode: string | null) =>
  `Chat mode: ${mode ?? 'non-dev'}\nSubagent task (effort hint: ${effortHint}):\n${task}`

const strongestOf = (chatModels: readonly Model[], tier: ModelTier) => {
  const nearestTier = nearestModelOf(chatModels, tier)?.tier
  return chatModels
    .filter((candidate) => candidate.tier === nearestTier)
    .toSorted(
      (first, second) => (second.dollarsPerMillionOutputTokens ?? 0) - (first.dollarsPerMillionOutputTokens ?? 0),
    )[0]
}

export const delegationChoiceOf = (reachable: readonly Model[], answers: Answers | undefined) => {
  const tier = answers?.tier
  if (!tier || tier.confidence < confidenceThreshold) return undefined
  const model = strongestOf(chatModelsOf(reachable), tier.value as ModelTier)
  return model && { model: model.id, effort: answers?.effort?.value ?? null, reason: `classified ${tier.value}` }
}

export const askedChoiceOf = (reachable: readonly Model[], asked: unknown, prompterName: string) => {
  const askedText = typeof asked === 'string' ? asked.trim() : ''
  const wanted = askedText ? routableModelOf(askedText) : undefined
  const tier = efforts.includes(askedText.toLowerCase()) ? (askedText.toLowerCase() as ModelTier) : wanted?.tier
  if (!tier) return undefined
  const chatModels = chatModelsOf(reachable)
  const model = chatModels.find((candidate) => candidate.id === wanted?.id) ?? strongestOf(chatModels, tier)
  if (!model) return undefined
  const isFallback = wanted ? model.id !== wanted.id : model.tier !== tier
  const fallback = `${wanted?.name ?? askedText} isn't reachable with ${prompterName}'s keys; used ${model.name}`
  return { model: model.id, reason: isFallback ? fallback : 'asked', ...(isFallback && { fallback }) }
}

export const subagentFailureOf = (modelName: string, notice?: string) =>
  `The subagent on ${modelName} stopped with an error${notice ? `: ${notice}` : ''}`
export const subagentStopped = 'The subagent was stopped'
export const stillRunningOf = (id: string) => `Task ${id} is still running; call await_task with taskId="${id}"`
export const unknownTaskOf = (id: string) => `There is no task ${id} running in this turn`
export const defaultResumeAfterMilliseconds = 45_000
export const delegateTimeoutSeconds = 120
