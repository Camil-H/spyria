import { chatId, type WorkspaceId } from '@hq/kernel'
import { DiffView, focusRing } from '@hq/ui'
import { Check, LoaderCircle, X } from 'lucide-react'
import { lazy, Suspense, use, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router'
import type { AgentStep as Step } from '../domain/agent-steps.ts'
import { type ConversationMessage, durationLabelOf } from '../queries/get-conversation.ts'
import { Disclosure, ThoughtStep } from './Disclosure.tsx'
import { QuestionAnswererContext, ToolsAwaitingApprovalContext, useConversationCommands } from './providers.tsx'

const QuestionCard = lazy(() => import('./QuestionCard.tsx'))
const DelegationStep = lazy(() => import('./DelegationStep.tsx'))

type StepOf<Type extends Step['type']> = Extract<Step, { type: Type }>

const failedPreviewLines = 5
const toolSummaryLength = 80
const outputClassName =
  'mt-1 max-h-96 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-xs whitespace-pre-wrap'

const CommandStep = ({ id, step, isRunning }: { id: string; step: StepOf<'command'>; isRunning: boolean }) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const currentChatId = chatId(useParams().chatId ?? '')
  const [fullOutput, setFullOutput] = useState<string>()
  const hasFailed = step.exitCode !== null && step.exitCode !== 0
  const status =
    step.exitCode === null ? (
      isRunning && <LoaderCircle role="img" aria-label="Running" className="size-4 shrink-0 animate-spin" />
    ) : hasFailed ? (
      <X role="img" aria-label="Failed" className="size-4 shrink-0 text-red-500" />
    ) : (
      <Check role="img" aria-label="Succeeded" className="size-4 shrink-0 text-green-500" />
    )
  return (
    <Disclosure
      label={
        <>
          {status}
          <code className="truncate font-mono text-ink">$ {step.command}</code>
          {step.exitCode !== null && (
            <span className="shrink-0 text-xs">
              exit {step.exitCode}
              {step.durationMilliseconds !== null && ` · ${durationLabelOf(step.durationMilliseconds)}`}
            </span>
          )}
        </>
      }
      preview={
        hasFailed && (
          <pre className={outputClassName}>{step.output.split('\n').slice(-failedPreviewLines).join('\n')}</pre>
        )
      }
    >
      <pre className={outputClassName}>{fullOutput ?? step.output}</pre>
      {step.truncatedLines > 0 && fullOutput === undefined && (
        <button
          type="button"
          onClick={() =>
            commands.commandOutput({ workspaceId, chatId: currentChatId, stepId: id }).then(setFullOutput, () => {})
          }
          className={`mt-1 text-xs text-muted underline hover:text-ink ${focusRing}`}
        >
          Show all
        </button>
      )}
    </Disclosure>
  )
}

const FileStep = ({ step }: { step: StepOf<'file'> }) =>
  step.operation === 'read' ? (
    <p className="pl-5.5 text-xs text-muted">Read {step.path}</p>
  ) : (
    <Disclosure
      label={
        <span>
          {step.operation === 'create' ? 'Created' : 'Edited'} <span className="text-ink">{step.path}</span>{' '}
          <span className="font-mono text-xs">
            +{step.added} −{step.removed}
          </span>
        </span>
      }
    >
      <div className="mt-1">
        <DiffView lines={step.diff} />
      </div>
    </Disclosure>
  )

const ToolStep = ({ step }: { step: StepOf<'tool'> }) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const { connection } = step
  const isAwaitingApproval = step.result === null && use(ToolsAwaitingApprovalContext).has(step.name)
  return (
    <>
      <Disclosure
        label={
          <>
            <span className="shrink-0">
              {isAwaitingApproval ? 'Waiting to use' : 'Used'} {step.name}
            </span>
            <code className="truncate font-mono text-xs">{step.arguments.slice(0, toolSummaryLength)}</code>
          </>
        }
      >
        <pre className={outputClassName}>{step.arguments}</pre>
        {step.result !== null && <pre className={outputClassName}>{step.result}</pre>}
      </Disclosure>
      {connection &&
        (use(QuestionAnswererContext).isOwner ? (
          <button
            type="button"
            onClick={() => commands.connectTool({ workspaceId, tool: connection.server }).catch(console.error)}
            className={`mt-1 ml-5.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover ${focusRing}`}
          >
            {connection.isReconnect ? 'Reconnect' : 'Connect'} {connection.server}
          </button>
        ) : (
          <p className="pl-5.5 text-sm text-muted">{step.result}</p>
        ))}
    </>
  )
}

const ErrorStep = ({ step }: { step: StepOf<'error'> }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  return (
    <p role="alert" className="rounded-md bg-removed px-2 py-1 text-sm">
      {step.message}
      {step.signIn && (
        <>
          {' '}
          <Link to={`/w/${workspaceId}/profile#my-machine`} className={`underline ${focusRing}`}>
            Open profile
          </Link>
        </>
      )}
    </p>
  )
}

const planStatusLabels: Record<string, string> = { 'in-progress': 'In progress', todo: 'To do' }

const PlanStep = ({ step }: { step: StepOf<'plan'> }) => (
  <fieldset aria-label="Plan" className="flex flex-col gap-1 text-sm">
    {step.items.map((item) => (
      <label key={item.title} className="flex items-center gap-2">
        <input type="checkbox" checked={item.status === 'done'} readOnly className="accent-accent" />
        {item.title}
        {planStatusLabels[item.status] && <span className="text-xs text-muted">{planStatusLabels[item.status]}</span>}
      </label>
    ))}
  </fieldset>
)

export const AgentStep = ({ message }: { message: ConversationMessage }) => {
  const step = message.step
  if (step?.type === 'thought') return <ThoughtStep step={step} />
  if (step?.type === 'command') return <CommandStep id={message.id} step={step} isRunning={message.isRunning} />
  if (step?.type === 'file') return <FileStep step={step} />
  if (message.delegation)
    return (
      <Suspense>
        <DelegationStep delegation={message.delegation}>
          {message.delegation.steps.map((delegated) => (
            <AgentStep key={delegated.id} message={delegated} />
          ))}
        </DelegationStep>
      </Suspense>
    )
  if (step?.type === 'tool') return <ToolStep step={step} />
  if (step?.type === 'plan') return <PlanStep step={step} />
  if (step?.type === 'question')
    return (
      <Suspense>
        <QuestionCard message={message} />
      </Suspense>
    )
  if (step?.type === 'error') return <ErrorStep step={step} />
  return null
}
