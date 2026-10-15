import { buttonClass, fieldClass, ghostButtonClass } from '@hq/ui'
import { type FormEvent, useState } from 'react'
import type { AgentQuestion, AgentStep } from '../domain/agent-steps.ts'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import type { QuestionAnswer } from './endpoints.ts'
import Markdown from './Markdown.tsx'

type QuestionStep = Extract<AgentStep, { type: 'question' }>

const closedLabels = { stopped: 'Stopped', cancelled: 'Cancelled', turn_end: 'Closed at turn end' }
const refusalNotices: Record<number, string> = {
  403: 'You cannot answer in this chat',
  409: 'This question is no longer waiting for an answer',
}

const outcomeOf = (step: QuestionStep, answeredByName: string | undefined) => {
  if (step.closed) return closedLabels[step.closed]
  const by = answeredByName ? ` by ${answeredByName}` : ''
  if (step.kind === 'plan') return `${step.approved ? 'Approved' : 'Kept planning'}${by}`
  const isSkipped =
    Object.keys(step.answers ?? {}).length === 0 && Object.values(step.free ?? {}).every((text) => text === '')
  return `${isSkipped ? 'Skipped' : 'Answered'}${by}`
}

const answerTextOf = (question: AgentQuestion, step: QuestionStep) =>
  [
    ...[step.answers?.[question.id] ?? []]
      .flat()
      .map((value) => question.options.find((option) => option.value === value)?.label ?? value),
    step.free?.[question.id],
  ]
    .filter(Boolean)
    .join(', ')

const QuestionCard = ({
  message,
  answerQuestion,
}: {
  message: ConversationMessage
  answerQuestion?: (questionId: string, answer: QuestionAnswer) => Promise<number>
}) => {
  const step = message.step as QuestionStep
  const [chosen, setChosen] = useState<Record<string, string[]>>({})
  const [free, setFree] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string>()
  const isPending = step.closed === undefined && step.answers === undefined && step.approved === undefined
  const canAnswer = isPending && answerQuestion !== undefined
  const send = async (answer: QuestionAnswer) => {
    const status = (await answerQuestion?.(step.questionId, answer).catch(() => 0)) ?? 0
    setNotice(status === 200 ? undefined : (refusalNotices[status] ?? 'The answer could not be sent'))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send({
      answers: Object.fromEntries(
        (step.questions ?? []).flatMap((question) => {
          const values = chosen[question.id] ?? []
          return values.length === 0 ? [] : [[question.id, question.multi ? values : (values[0] ?? '')]]
        }),
      ),
      free: Object.fromEntries(Object.entries(free).filter(([, text]) => text.trim() !== '')),
    })
  }
  const choose = (question: AgentQuestion, value: string, isChecked: boolean) => {
    const values = chosen[question.id] ?? []
    setChosen({
      ...chosen,
      [question.id]: question.multi
        ? isChecked
          ? [...values, value]
          : values.filter((chosenValue) => chosenValue !== value)
        : [value],
    })
  }
  const outcome = !isPending && <p className="text-xs text-muted">{outcomeOf(step, message.answeredByName)}</p>
  const alert = notice && (
    <p role="alert" className="rounded-md bg-removed px-2 py-1 text-sm">
      {notice}
    </p>
  )
  if (step.kind === 'plan')
    return (
      <section aria-label="Plan approval" className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
        <Markdown text={step.plan ?? ''} />
        {canAnswer && (
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={() => send({ approve: true })}>
              Approve the plan
            </button>
            <button type="button" className={ghostButtonClass} onClick={() => send({ approve: false })}>
              Keep planning
            </button>
          </div>
        )}
        {outcome}
        {alert}
      </section>
    )
  return (
    <form
      aria-label="Question"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3 text-sm"
    >
      {(step.questions ?? []).map((question) => (
        <fieldset key={question.id} disabled={!canAnswer} className="flex flex-col gap-1.5">
          <legend className="mb-1">
            {question.header && <span className="block text-xs text-muted">{question.header}</span>} {question.text}
          </legend>
          {isPending ? (
            <>
              {question.options.map((option) => (
                <label key={option.value} className="flex items-baseline gap-2">
                  <input
                    type={question.multi ? 'checkbox' : 'radio'}
                    name={`${step.questionId}-${question.id}`}
                    value={option.value}
                    checked={chosen[question.id]?.includes(option.value) ?? false}
                    onChange={(event) => choose(question, option.value, event.target.checked)}
                    className="accent-accent"
                  />
                  <span>
                    {option.label}{' '}
                    {option.description && <span className="text-xs text-muted">{option.description}</span>}
                  </span>
                </label>
              ))}
              {question.free && (
                <input
                  aria-label={`Other answer to ${question.text}`}
                  placeholder="Other"
                  value={free[question.id] ?? ''}
                  onChange={(event) => setFree({ ...free, [question.id]: event.target.value })}
                  className={fieldClass}
                />
              )}
            </>
          ) : (
            answerTextOf(question, step) && <p className="text-ink">{answerTextOf(question, step)}</p>
          )}
        </fieldset>
      ))}
      {canAnswer && (
        <div className="flex gap-2">
          <button type="submit" className={buttonClass}>
            Submit
          </button>
          <button type="button" className={ghostButtonClass} onClick={() => send({ answers: {} })}>
            Skip
          </button>
        </div>
      )}
      {outcome}
      {alert}
    </form>
  )
}

export default QuestionCard
