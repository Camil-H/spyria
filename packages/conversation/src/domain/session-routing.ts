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

export const harnesses = {
  'claude-code': {
    name: 'Claude Code',
    model: 'anthropic/claude-opus-5-5',
    keysNotice: 'This session runs Claude Code on Anthropic keys',
  },
  codex: { name: 'Codex', model: 'openai/gpt-6.1-sol', keysNotice: 'This session runs Codex on OpenAI keys' },
} as const
export type Harness = keyof typeof harnesses
export type HarnessLaunch = Harness | 'claude-code-subscription' | 'codex-subscription'
export const localSessionNotices = { ownerOnly: 'Only the owner prompts a session on their machine' }
export const localSessions = {
  'claude-code': {
    launch: 'claude-code-subscription',
    signIn: 'claude',
    signInNotice: 'Sign in to Claude Code on your machine: docker exec -it hq-host hq-host login claude',
  },
  codex: {
    launch: 'codex-subscription',
    signIn: 'codex',
    signInNotice: 'Sign in to Codex on your machine: docker exec -it hq-host hq-host login codex',
  },
} as const satisfies Record<Harness, { launch: HarnessLaunch; signIn: string; signInNotice: string }>
export type LocalSession = (typeof localSessions)[Harness]
const providerOf = (model: string) => model.split('/')[0]
export const reachesHarness = (harness: Harness, reachable: readonly Model[]) =>
  reachable.some((model) => providerOf(model.id) === providerOf(harnesses[harness].model))
export const harnessOfKeys = (reachable: readonly Model[]): Harness | undefined =>
  (Object.keys(harnesses) as Harness[]).find(
    (harness) => reachable.length > 0 && reachable.every((model) => reachesHarness(harness, [model])),
  )
