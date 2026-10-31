import { type DevLoopStepConfig, devLoopRange } from '@spyria/kernel'
import { fieldClass, iconButtonClass, labelClass, smallGhostButtonClass } from '@spyria/ui'
import { ArrowDown, ArrowUp, GitPullRequest, Plus, ScanSearch, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import {
  addableKindsOf,
  stepKindLabels,
  withoutStep,
  withStep,
  withStepChanged,
  withStepMoved,
} from '../domain/dev-loop.ts'

type Change = (change: Partial<Record<string, unknown>>) => void

const kindIcons = { command: Terminal, review: ScanSearch, pull_request: GitPullRequest, ci: ShieldCheck }
const failureLabels = { command: 'If it fails', review: 'If it finds a defect', ci: 'If a check fails' }

const numberOf = (value: string) => (value === '' ? Number.NaN : Number(value))

const FailureRule = ({
  step,
  label,
  change,
}: {
  step: DevLoopStepConfig & { fixes: number }
  label: string
  change: Change
}) => (
  <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
    <label className="flex items-center gap-2">
      {label}
      <select
        className={fieldClass}
        value={step.fixes === 0 ? 'stop' : 'fix'}
        onChange={(event) => change({ fixes: event.target.value === 'stop' ? 0 : 3 })}
      >
        <option value="fix">send it back to the agent</option>
        <option value="stop">stop and hand over to the owner</option>
      </select>
    </label>
    {step.fixes > 0 && (
      <label className="flex items-center gap-2">
        up to
        <input
          type="number"
          min={1}
          max={devLoopRange.fixes.maximum}
          required
          aria-label="Times a failure goes back to the agent"
          className={`${fieldClass} w-16`}
          value={Number.isNaN(step.fixes) ? '' : step.fixes}
          onChange={(event) => change({ fixes: numberOf(event.target.value) })}
        />
        {step.fixes === 1 ? 'time' : 'times'}, then hand over
      </label>
    )}
  </div>
)

const StepFields = ({ step, change }: { step: DevLoopStepConfig; change: Change }) => {
  if (step.kind === 'pull_request')
    return (
      <p className="text-sm text-muted">
        Pushes the branch as the chat owner and opens the pull request, or updates the open one.
      </p>
    )
  if (step.kind === 'review')
    return (
      <>
        <p className="text-sm text-muted">A subagent with a fresh context reviews the diff.</p>
        <FailureRule step={step} label={failureLabels.review} change={change} />
      </>
    )
  if (step.kind === 'ci')
    return (
      <>
        <p className="text-sm text-muted">
          Every check GitHub reports on the pushed commit must pass. A skipped check counts as passed.
        </p>
        <FailureRule step={step} label={failureLabels.ci} change={change} />
      </>
    )
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <label className={labelClass}>
          Name
          <input
            required
            maxLength={60}
            placeholder="Lint"
            className={`${fieldClass} w-40`}
            value={step.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <label className={`${labelClass} min-w-64 flex-1`}>
          Command
          <input
            required
            placeholder="bun run lint, or sh scripts/check.sh"
            className={`${fieldClass} font-mono`}
            value={step.command}
            onChange={(event) => change({ command: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          Timeout (minutes)
          <input
            type="number"
            required
            min={devLoopRange.timeoutMinutes.minimum}
            max={devLoopRange.timeoutMinutes.maximum}
            className={`${fieldClass} w-24`}
            value={Number.isNaN(step.timeoutMinutes) ? '' : step.timeoutMinutes}
            onChange={(event) => change({ timeoutMinutes: numberOf(event.target.value) })}
          />
        </label>
      </div>
      <FailureRule step={step} label={failureLabels.command} change={change} />
    </>
  )
}

export const DevLoopPipelineEditor = ({
  steps,
  onChange,
}: {
  steps: readonly DevLoopStepConfig[]
  onChange: (steps: readonly DevLoopStepConfig[]) => void
}) => (
  <div className="flex flex-col gap-4">
    <p className="text-sm text-muted">
      Keep each check's logic in a script in the repository, such as a package script or scripts/check.sh: a gate only
      runs it, so developers and agents run the same thing. Every member can read the gates: never put a secret in a
      command.
    </p>
    <ol aria-label="Gates" className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const Icon = kindIcons[step.kind]
        const name = step.kind === 'command' && step.name ? step.name : stepKindLabels[step.kind]
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: gates have no identity, and a key from their content would remount the field being typed in
            key={`${step.kind}-${index}`}
            aria-label={`Gate ${index + 1}: ${name}`}
            className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{index + 1}</span>
              <Icon aria-hidden size={16} className="text-muted" />
              <span className="font-medium">{stepKindLabels[step.kind]}</span>
              <span className="ml-auto flex gap-1">
                <button
                  type="button"
                  aria-label={`Move ${name} up`}
                  className={iconButtonClass}
                  disabled={withStepMoved(steps, index, -1) === steps}
                  onClick={() => onChange(withStepMoved(steps, index, -1))}
                >
                  <ArrowUp aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${name} down`}
                  className={iconButtonClass}
                  disabled={withStepMoved(steps, index, 1) === steps}
                  onClick={() => onChange(withStepMoved(steps, index, 1))}
                >
                  <ArrowDown aria-hidden size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className={iconButtonClass}
                  onClick={() => onChange(withoutStep(steps, index))}
                >
                  <Trash2 aria-hidden size={14} />
                </button>
              </span>
            </div>
            <StepFields step={step} change={(change) => onChange(withStepChanged(steps, index, change))} />
          </li>
        )
      })}
    </ol>
    {steps.length === 0 && <p className="text-sm text-muted">No gate: the owner reviews the work as it is.</p>}
    <div className="flex flex-wrap items-center gap-2">
      {addableKindsOf(steps).map((kind) => (
        <button
          key={kind}
          type="button"
          className={`flex items-center gap-1 ${smallGhostButtonClass}`}
          onClick={() => onChange(withStep(steps, kind))}
        >
          <Plus aria-hidden size={12} />
          {stepKindLabels[kind]}
        </button>
      ))}
    </div>
  </div>
)
