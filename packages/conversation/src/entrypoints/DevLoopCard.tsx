import type { DevLoopStepConfig } from '@spyria/kernel'
import { CircleCheck, CircleDashed, CircleX, IterationCw, LoaderCircle } from 'lucide-react'
import { type DevLoopState, type DevLoopStep, devLoopStepOf, isBlocking, stepNameOf } from '../domain/dev-loop.ts'

const stateLabels: Record<DevLoopState, string> = {
  working: 'Agent working',
  running: 'Running',
  reviewing: 'Reviewing',
  waiting_for_ci: 'Waiting for CI',
  handing_off: 'Handing over',
  done: 'Done',
  stopped: 'Stopped',
}
const stateClasses: Record<DevLoopState, string> = {
  working: 'bg-hover text-muted',
  running: 'bg-hover text-muted',
  reviewing: 'bg-hover text-muted',
  waiting_for_ci: 'bg-hover text-muted',
  handing_off: 'bg-removed text-ink',
  done: 'bg-added text-ink',
  stopped: 'bg-removed text-ink',
}
const activeStates: DevLoopState[] = ['running', 'reviewing', 'waiting_for_ci']
type StepStatus = 'passed' | 'failed' | 'running' | 'waiting'
const statusIcons = {
  passed: CircleCheck,
  failed: CircleX,
  running: LoaderCircle,
  waiting: CircleDashed,
} satisfies Record<StepStatus, unknown>

const statusOf = (step: DevLoopStep, index: number): StepStatus =>
  index === step.position && activeStates.includes(step.state) ? 'running' : (step.outcomes[index] ?? 'waiting')

const fixesOf = (config: DevLoopStepConfig, round: number) =>
  'fixes' in config && config.fixes > 0 && round > 0
    ? `sent back ${Math.min(round, config.fixes)} of ${config.fixes} times`
    : undefined

const DevLoopCard = ({ step: stored }: { step: DevLoopStep }) => {
  const step = devLoopStepOf(stored)
  const blocking = step.findings.filter(isBlocking)
  return (
    <section
      aria-label="Quality gates"
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <IterationCw aria-hidden size={16} className="shrink-0 text-muted" />
        <span className="font-medium">{step.summary.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${stateClasses[step.state]}`}>
          {stateLabels[step.state]}
        </span>
      </div>
      <ol aria-label="Steps" className="flex flex-col gap-1 text-xs">
        {step.pipeline.map((config, index) => {
          const status = statusOf(step, index)
          const Icon = statusIcons[status]
          const fixes = fixesOf(config, step.rounds[index] ?? 0)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a pipeline never changes during a loop, and its steps have no identity
            <li key={`${config.kind}-${index}`} className="flex items-center gap-1.5">
              <Icon
                role="img"
                aria-label={status}
                size={14}
                className={`shrink-0 text-muted ${status === 'running' ? 'animate-spin' : ''}`}
              />
              <span>{stepNameOf(config)}</span>
              {config.kind === 'review' && step.findings.length > 0 && (
                <span className="text-muted">
                  {step.findings.length} {step.findings.length === 1 ? 'finding' : 'findings'}, {blocking.length}{' '}
                  important
                </span>
              )}
              {config.kind === 'pull_request' && step.pullRequestNumber !== null && (
                <span className="text-muted">#{step.pullRequestNumber}</span>
              )}
              {fixes && <span className="text-muted">· {fixes}</span>}
            </li>
          )
        })}
      </ol>
      {blocking.length > 0 && (
        <ul aria-label="Important findings" className="flex flex-col gap-1 text-xs">
          {blocking.map((finding) => {
            const Icon = finding.isResolved ? CircleCheck : CircleX
            return (
              <li key={finding.id} className="flex items-start gap-1.5">
                <Icon
                  role="img"
                  aria-label={finding.isResolved ? 'fixed' : 'not fixed'}
                  size={14}
                  className="mt-0.5 shrink-0 text-muted"
                />
                <span className="min-w-0 break-words">
                  <span className="text-muted">
                    {finding.path}
                    {finding.line === null ? '' : `:${finding.line}`}
                  </span>{' '}
                  {finding.title}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {step.outcome && <p>{step.outcome}</p>}
    </section>
  )
}

export default DevLoopCard
