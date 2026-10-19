import { isDecisionModel, type Model } from '@spyria/kernel'

export type Questions = Readonly<Record<string, { instructions: string; criteria: Readonly<Record<string, string>> }>>
export type Answers = Readonly<Record<string, { value: string; confidence: number }>>

export const confidenceThreshold = 0.8
const selfRatedConfidence: Record<string, number> = { high: 1, low: 0 }

const mapQuestions = <Value>(questions: Questions, convert: (question: Questions[string]) => Value) =>
  Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, convert(question)]))

export const decisionRequestOf = (model: Model, state: string, questions: Questions) =>
  isDecisionModel(model)
    ? {
        model: model.id,
        state,
        questions: mapQuestions(questions, (question) => ({ kind: 'choice', ...question })),
      }
    : {
        model: model.id,
        max_tokens: 200,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Answer with the JSON schema only. confidence: high only when every answer is clear.\n${Object.entries(
              questions,
            )
              .map(([name, { instructions, criteria }]) => `${name}: ${instructions} ${JSON.stringify(criteria)}`)
              .join('\n')}`,
          },
          { role: 'user', content: state },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'decision',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [...Object.keys(questions), 'confidence'],
              properties: {
                ...mapQuestions(questions, ({ criteria }) => ({ type: 'string', enum: Object.keys(criteria) })),
                confidence: { type: 'string', enum: Object.keys(selfRatedConfidence) },
              },
            },
          },
        },
      }

const firstJsonObjectOf = (text: string) => {
  const start = text.indexOf('{')
  for (let end = text.indexOf('}', start); start >= 0 && end >= 0; end = text.indexOf('}', end + 1))
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    } catch {}
  return undefined
}

const validAnswersOf = (questions: Questions, answerOf: (name: string) => { value: unknown; confidence: unknown }) => {
  const answers = Object.entries(questions).map(([name, { criteria }]) => {
    const { value, confidence } = answerOf(name)
    return typeof value === 'string' && Object.hasOwn(criteria, value) && typeof confidence === 'number'
      ? [name, { value, confidence }]
      : undefined
  })
  return answers.every(Boolean) ? (Object.fromEntries(answers as [string, unknown][]) as Answers) : undefined
}

export const answersOf = (model: Model, questions: Questions, body: unknown): Answers | undefined => {
  if (isDecisionModel(model)) {
    const answers = (body as { answers?: Record<string, { value?: unknown; confidence?: unknown }> })?.answers
    return validAnswersOf(questions, (name) => ({
      value: answers?.[name]?.value,
      confidence: answers?.[name]?.confidence ?? 0,
    }))
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
  const parsed = typeof content === 'string' ? firstJsonObjectOf(content) : undefined
  return validAnswersOf(questions, (name) => ({
    value: parsed?.[name],
    confidence: selfRatedConfidence[String(parsed?.confidence)],
  }))
}
