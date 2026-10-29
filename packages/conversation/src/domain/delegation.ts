import { chatModelsOf, type Model, type ModelTier, nearestModelOf, routableModelOf } from '@spyria/kernel'
import type { AgentStep } from './agent-steps.ts'
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
export const checkTaskTool = {
  name: 'check_task',
  description:
    'Read the steps a delegated task has taken so far, or stop it with cancel=true; returns its final answer once it has finished.',
  inputSchema: {
    type: 'object',
    required: ['taskId'],
    properties: { taskId: { type: 'string' }, cancel: { type: 'boolean' } },
  },
}
export const routerTools = [delegateTool, awaitTaskTool, checkTaskTool]

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

const shownTaskSteps = 20
const shownThoughtCharacters = 200
const fileVerbs = { read: 'read', create: 'created', edit: 'edited' }
const taskStepLineOf = (step: AgentStep) => {
  if (step.type === 'command') return `ran ${step.command}${step.exitCode === null ? '' : ` (exit ${step.exitCode})`}`
  if (step.type === 'file') return `${fileVerbs[step.operation]} ${step.path}`
  if (step.type === 'tool') return `called ${step.name}${step.isError ? ' (failed)' : ''}`
  if (step.type === 'thought') return `thought: ${step.text.slice(0, shownThoughtCharacters)}`
  if (step.type === 'error') return `error: ${step.message}`
  return step.type.replace('_', ' ')
}
const taskStepsOf = (steps: readonly AgentStep[]) => {
  const hidden = steps.length - shownTaskSteps
  return [
    ...(hidden > 0 ? [`(${hidden} earlier steps not shown)`] : []),
    ...steps.slice(-shownTaskSteps).map((step) => `- ${taskStepLineOf(step)}`),
  ].join('\n')
}
export const taskProgressOf = (id: string, steps: readonly AgentStep[]) =>
  steps.length === 0
    ? `Task ${id} is running and has taken no step yet`
    : `Task ${id} is running; its steps so far:\n${taskStepsOf(steps)}`
export const cancelledTaskOf = (id: string, steps: readonly AgentStep[]) =>
  steps.length === 0
    ? `Task ${id} was cancelled before taking any step`
    : `Task ${id} was cancelled; its steps:\n${taskStepsOf(steps)}`
export const taskReportOf = (id: string, text: string | null) =>
  text?.startsWith(`Task ${id} is running`)
    ? 'running'
    : text?.startsWith(`Task ${id} was cancelled`)
      ? 'cancelled'
      : undefined
