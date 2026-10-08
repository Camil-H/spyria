import { chatModelsOf, type Model, type ModelTier, modelNameOf, nearestModelOf, tierOf } from '@hq/kernel'
import { type Answers, confidenceThreshold } from './decisions.ts'

export type Effort = 'high' | 'medium' | 'low'
export type SessionChoice = Readonly<{ model: Model; effort: Effort; reason: string }>

export const sessionQuestions = {
  tier: {
    instructions: 'The model tier this coding agent session needs.',
    criteria: {
      large: 'hard, open-ended or architectural work',
      medium: 'everything else',
      small: 'trivial questions or edits',
    },
  },
  effort: {
    instructions: 'The reasoning effort the task needs.',
    criteria: { high: 'deep reasoning', medium: 'some reasoning', low: 'little reasoning' },
  },
} as const

export const sessionStateOf = (message: string, mode: string | null) =>
  `Chat mode: ${mode ?? 'non-dev'}\nFirst message:\n${message}`

export const sessionChoiceOf = ({
  reachable,
  defaultModel,
  answers,
}: {
  reachable: readonly Model[]
  defaultModel: string | null
  answers: Answers | undefined
}): SessionChoice | undefined => {
  const effort = (answers?.effort?.value ?? 'medium') as Effort
  const tier = answers?.tier
  const confidentTier =
    tier && tier.confidence >= confidenceThreshold && tier.value !== 'medium' ? (tier.value as ModelTier) : undefined
  const chatModels = chatModelsOf(reachable)
  if (confidentTier) {
    const model = nearestModelOf(chatModels, confidentTier)
    return model && { model, effort, reason: `classified ${confidentTier}` }
  }
  const model =
    chatModels.find((candidate) => candidate.id === defaultModel) ??
    nearestModelOf(chatModels, tierOf(defaultModel) ?? 'medium')
  return model && { model, effort, reason: 'default' }
}

export const unreachableSessionNoticeOf = (model: string) =>
  `Your keys cannot reach ${modelNameOf(model)}; switch the model or add a key`
