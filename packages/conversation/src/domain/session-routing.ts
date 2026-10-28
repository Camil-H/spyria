import {
  chatModelsOf,
  type HarnessId,
  harnesses,
  harnessIds,
  harnessOf,
  type Model,
  type ModelTier,
  modelNameOf,
  nearestModelOf,
} from '@spyria/kernel'
import { type Answers, confidenceThreshold } from './decisions.ts'

export type Effort = 'high' | 'medium' | 'low'
type SessionChoice = Readonly<{ model: Model; effort: Effort; reason: string }>

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

export const piThoughtLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
export const piModelOf = (id: string) => `${id.startsWith('anthropic/') ? 'spyria-anthropic' : 'spyria'}/${id}`
export const thoughtLevelOf = (effort: string | null) =>
  effort && piThoughtLevels.includes(effort) ? effort : undefined

const unreachableSessionNoticePrefix = 'Your keys cannot reach '
export const unreachableSessionNoticeOf = (model: string) =>
  `${unreachableSessionNoticePrefix}${modelNameOf(model)}; switch the model or add a key`
export const isUnreachableSessionNotice = (body: string) => body.startsWith(unreachableSessionNoticePrefix)

export const localSessionNotices = {
  ownerOnly: 'Only the owner prompts a session on their machine',
  turnedOff: "Sessions on members' machines are turned off for this workspace",
}
export type RunsOn = 'runtime' | HarnessId
export const runsOns = ['runtime', ...harnessIds] as [RunsOn, ...RunsOn[]]
export const runsOnNames = {
  runtime: 'Spyria runtime',
  ...Object.fromEntries(harnessIds.map((harness) => [harness, `Local · ${harnesses[harness].name}`])),
} as Record<RunsOn, string>
export const runsOnFieldsOf = (runsOn: RunsOn) =>
  runsOn === 'runtime' ? { harness: null, localSession: false } : { harness: runsOn, localSession: true }
export const runsOnOf = (chat: { localSession: boolean | null; harness: HarnessId | null }): RunsOn | null =>
  chat.localSession === null ? null : chat.localSession ? harnessOf(chat.harness) : 'runtime'
export const runsOnWaitingNoticeOf = (ownerName: string) => `Waiting for ${ownerName} to choose where this chat runs`
const effortSuffixOf = (reasoningEffort: string | null) => (reasoningEffort ? ` (${reasoningEffort})` : '')
export const chipLabelOf = (
  {
    localSession,
    harness,
    model,
    reasoningEffort,
    isAgentWorking = false,
  }: {
    localSession: boolean
    harness: HarnessId | null
    model: string | null
    reasoningEffort: string | null
    isAgentWorking?: boolean
  },
  nameOf: (id: string) => string,
  adapterNameOf: (id: string) => string,
) =>
  localSession
    ? `${harnesses[harnessOf(harness)].name} · ${model ? adapterNameOf(model) : 'subscription'}${effortSuffixOf(reasoningEffort)}`
    : model
      ? `${nameOf(model)}${effortSuffixOf(reasoningEffort)}`
      : isAgentWorking
        ? 'Choosing model…'
        : 'Model chosen at first prompt'
