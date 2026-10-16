import { chatModelsOf, type Model, type ModelTier, modelNameOf, nearestModelOf } from '@hq/kernel'
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
  answers,
}: {
  reachable: readonly Model[]
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
  const model = nearestModelOf(chatModels, 'medium')
  return model && { model, effort, reason: 'default' }
}

const piThoughtLevels = ['off', 'minimal', 'low', 'medium', 'high']
export const piModelOf = (id: string) => `${id.startsWith('anthropic/') ? 'hq-anthropic' : 'hq'}/${id}`
export const thoughtLevelOf = (effort: string | null) =>
  effort && piThoughtLevels.includes(effort) ? effort : undefined

export const unreachableSessionNoticeOf = (model: string) =>
  `Your keys cannot reach ${modelNameOf(model)}; switch the model or add a key`

export const harnesses = { 'claude-code': { name: 'Claude Code' }, codex: { name: 'Codex' } } as const
export type Harness = keyof typeof harnesses
export type HarnessLaunch = 'claude-code-subscription' | 'codex-subscription'
export const localSessionNotices = {
  ownerOnly: 'Only the owner prompts a session on their machine',
  turnedOff: "Sessions on members' machines are turned off for this workspace",
}
export const localSessions = {
  'claude-code': {
    launch: 'claude-code-subscription',
    signIn: 'claude',
    signInNotice: 'Sign in to Claude Code on your machine: docker exec -it hq-host hq-host login claude',
    expiredNotice: 'Authentication required — sign in to Claude Code again',
  },
  codex: {
    launch: 'codex-subscription',
    signIn: 'codex',
    signInNotice: 'Sign in to Codex on your machine: docker exec -it hq-host hq-host login codex',
    expiredNotice: 'Authentication required — sign in to Codex again',
  },
} as const satisfies Record<
  Harness,
  { launch: HarnessLaunch; signIn: string; signInNotice: string; expiredNotice: string }
>
export type LocalSession = (typeof localSessions)[Harness]
export type RunsOn = 'runtime' | Harness
export const runsOnNames: Record<RunsOn, string> = {
  runtime: 'HQ runtime',
  'claude-code': 'My machine · Claude Code',
  codex: 'My machine · Codex',
}
export const runsOnFieldsOf = (runsOn: RunsOn) =>
  runsOn === 'runtime' ? { harness: null, localSession: false } : { harness: runsOn, localSession: true }
export const runsOnOf = (chat: { localSession: boolean | null; harness: Harness | null }): RunsOn | null =>
  chat.localSession === null ? null : chat.localSession ? (chat.harness ?? 'claude-code') : 'runtime'
export const runsOnWaitingNoticeOf = (ownerName: string) => `Waiting for ${ownerName} to choose where this chat runs`
export const subagentPolicyNames = { auto: 'auto', same_as_main: 'same as main' } as const
export const chipLabelOf = (
  {
    localSession,
    harness,
    model,
    reasoningEffort,
    subagentPolicy,
  }: {
    localSession: boolean
    harness: Harness | null
    model: string | null
    reasoningEffort: string | null
    subagentPolicy: keyof typeof subagentPolicyNames
  },
  nameOf: (id: string) => string,
  adapterNameOf: (id: string) => string,
) =>
  localSession
    ? `${harnesses[harness ?? 'claude-code'].name} · ${model ? adapterNameOf(model) : 'subscription'}`
    : model
      ? `${nameOf(model)}${reasoningEffort ? ` (${reasoningEffort})` : ''} · ${subagentPolicyNames[subagentPolicy]}`
      : 'Model chosen at first prompt'
