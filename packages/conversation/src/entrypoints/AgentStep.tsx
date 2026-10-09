import { chatId, type WorkspaceId } from '@hq/kernel'
import { DiffView, focusRing } from '@hq/ui'
import { Check, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useOutletContext, useParams } from 'react-router'
import type { AgentStep as Step } from '../domain/agent-steps.ts'
import { type ConversationMessage, durationLabelOf } from '../queries/get-conversation.ts'
import { useConversationCommands } from './providers.tsx'

type StepOf<Type extends Step['type']> = Extract<Step, { type: Type }>

const failedPreviewLines = 5
const toolSummaryLength = 80
const outputClassName =
  'mt-1 max-h-96 overflow-auto rounded-md border border-line bg-app p-2 font-mono text-xs whitespace-pre-wrap'

const Disclosure = ({
  label,
  isInitiallyOpen = false,
  preview,
  children,
}: {
  label: ReactNode
  isInitiallyOpen?: boolean
  preview?: ReactNode
  children: ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen)
  return (
    <>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex max-w-full items-center gap-1.5 rounded-md text-left text-sm text-muted hover:text-ink ${focusRing} aria-expanded:[&>svg:first-child]:rotate-90`}
      >
        <ChevronRight aria-hidden className="size-4 shrink-0 transition-transform" />
        {label}
      </button>
      {isOpen ? children : preview}
    </>
  )
}

const ThoughtStep = ({ step }: { step: StepOf<'thought'> }) => (
  <Disclosure
    label={
      step.durationMilliseconds === null ? 'Thinking…' : `Thought for ${durationLabelOf(step.durationMilliseconds)}`
    }
    isInitiallyOpen={step.durationMilliseconds === null}
  >
    <p className="mt-1 border-l-2 border-line pl-3 text-sm whitespace-pre-wrap text-muted">{step.text}</p>
  </Disclosure>
)

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
          onClick={async () =>
            setFullOutput(await commands.commandOutput({ workspaceId, chatId: currentChatId, stepId: id }))
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

const ToolStep = ({ step, canConnect }: { step: StepOf<'tool'>; canConnect: boolean }) => {
  const commands = useConversationCommands()
  const workspaceId = useOutletContext<WorkspaceId>()
  const { connection } = step
  return (
    <>
      <Disclosure
        label={
          <>
            <span className="shrink-0">Used {step.name}</span>
            <code className="truncate font-mono text-xs">{step.arguments.slice(0, toolSummaryLength)}</code>
          </>
        }
      >
        <pre className={outputClassName}>{step.arguments}</pre>
        {step.result !== null && <pre className={outputClassName}>{step.result}</pre>}
      </Disclosure>
      {connection &&
        (canConnect ? (
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

const DelegationStep = ({ delegation }: { delegation: NonNullable<ConversationMessage['delegation']> }) => {
  const { modelName, status, result, fallback } = delegation
  const count = delegation.steps.length
  const duration = delegation.durationMilliseconds
  return (
    <>
      <Disclosure
        label={
          status === 'running' ? (
            <>
              <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
              Delegating to {modelName}…
            </>
          ) : (
            `Delegated to ${modelName}${status === 'finished' ? '' : ` · ${status}`} · ${count} step${count === 1 ? '' : 's'}${duration === null ? '' : ` · ${durationLabelOf(duration)}`}`
          )
        }
      >
        <fieldset aria-label={`Steps of ${modelName}`} className="mt-1 flex flex-col gap-1 border-l-2 border-line pl-3">
          {delegation.steps.map((delegated) => (
            <AgentStep key={delegated.id} message={delegated} />
          ))}
        </fieldset>
        {result !== null && <p className="mt-1 pl-3 text-sm whitespace-pre-wrap">{result}</p>}
      </Disclosure>
      {fallback && <p className="pl-5.5 text-xs text-muted">{fallback}</p>}
    </>
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
  if (message.delegation) return <DelegationStep delegation={message.delegation} />
  if (step?.type === 'tool') return <ToolStep step={step} canConnect={message.canConnectTools} />
  if (step?.type === 'plan') return <PlanStep step={step} />
  if (step?.type === 'error')
    return (
      <p role="alert" className="rounded-md bg-removed px-2 py-1 text-sm">
        {step.message}
      </p>
    )
  return null
}
