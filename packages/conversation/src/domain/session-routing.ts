import { type CatalogModel, catalogModelOf, type ModelTier, modelNameOf, nearestModelOf } from '@hq/kernel'

export type Effort = 'high' | 'medium' | 'low'
export type Classification = Readonly<{ tier: ModelTier; confidence: 'high' | 'low'; effort: Effort; reason: string }>
export type SessionChoice = Readonly<{ model: CatalogModel; effort: Effort; reason: string }>

const allowed = {
  tier: ['large', 'medium', 'small'],
  confidence: ['high', 'low'],
  effort: ['high', 'medium', 'low'],
} as const
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['tier', 'confidence', 'effort', 'reason'],
  properties: {
    tier: { type: 'string', enum: allowed.tier },
    confidence: { type: 'string', enum: allowed.confidence },
    effort: { type: 'string', enum: allowed.effort },
    reason: { type: 'string' },
  },
}
const instructions = `You route a coding agent session to a model tier. Answer with the JSON schema only.
tier: large for hard, open-ended or architectural work, small for trivial questions or edits, medium otherwise.
confidence: high only when the request clearly belongs to its tier. effort: the reasoning effort the task needs.`

export const classifierRequestOf = ({
  model,
  message,
  mode,
}: {
  model: string
  message: string
  mode: string | null
}) => ({
  model,
  max_tokens: 200,
  temperature: 0,
  messages: [
    { role: 'system', content: instructions },
    { role: 'user', content: `Chat mode: ${mode ?? 'non-dev'}\nFirst message:\n${message}` },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'session', strict: true, schema } },
})

export const classificationOf = (content: string | undefined): Classification | undefined => {
  try {
    const parsed = JSON.parse(content ?? '')
    const isValid =
      typeof parsed?.reason === 'string' &&
      (Object.keys(allowed) as (keyof typeof allowed)[]).every((field) =>
        (allowed[field] as readonly unknown[]).includes(parsed[field]),
      )
    return isValid
      ? { tier: parsed.tier, confidence: parsed.confidence, effort: parsed.effort, reason: parsed.reason }
      : undefined
  } catch {
    return undefined
  }
}

export const sessionChoiceOf = ({
  reachable,
  defaultModel,
  classification,
}: {
  reachable: readonly CatalogModel[]
  defaultModel: string | null
  classification: Classification | undefined
}): SessionChoice | undefined => {
  const effort = classification?.effort ?? 'medium'
  const confidentTier =
    classification?.confidence === 'high' && classification.tier !== 'medium' ? classification.tier : undefined
  if (confidentTier) {
    const model = nearestModelOf(reachable, confidentTier)
    return model && { model, effort, reason: `classified ${confidentTier}` }
  }
  const model =
    reachable.find((candidate) => candidate.id === defaultModel) ??
    nearestModelOf(reachable, catalogModelOf(defaultModel)?.tier ?? 'medium')
  return model && { model, effort, reason: 'default' }
}

export const unreachableSessionNoticeOf = (model: string) =>
  `Your keys cannot reach ${modelNameOf(model)}; switch the model or add a key`
