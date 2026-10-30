import { type DevLoopPipeline, type DevLoopStepConfig, devLoopRange } from '@spyria/kernel'
import { fieldClass, iconButtonClass, labelClass, smallGhostButtonClass } from '@spyria/ui'
import { ArrowDown, ArrowUp, GitPullRequest, Plus, ScanSearch, Terminal, Trash2, Workflow } from 'lucide-react'
import { useState } from 'react'
import {
  addableKindsOf,
  stepKindLabels,
  withoutStep,
  withStep,
  withStepChanged,
  withStepMoved,
} from '../domain/dev-loop.ts'

type Change = (change: Partial<Record<string, unknown>>) => void

const kindIcons = { command: Terminal, review: ScanSearch, pull_request: GitPullRequest, ci: Workflow }
const failureLabels = { command: 'If it fails', review: 'If it finds a defect', ci: 'If it fails' }

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
        times, then hand over
      </label>
    )}
  </div>
)

const CheckNames = ({
  checks,
  suggestions,
  change,
}: {
  checks: readonly string[] | null
  suggestions: readonly string[]
  change: Change
}) => {
  const [name, setName] = useState('')
  const add = () => {
    const trimmed = name.trim()
    if (trimmed && !checks?.includes(trimmed)) change({ checks: [...(checks ?? []), trimmed] })
    setName('')
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="text-muted">
        {checks === null ? 'Every check on the pull request counts.' : 'Only these checks count:'}
      </span>
      {checks !== null && (
        <ul aria-label="Checks that count" className="flex flex-wrap gap-2">
          {checks.map((check) => (
            <li key={check} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5">
              {check}
              <button
                type="button"
                aria-label={`Stop counting ${check}`}
                className={iconButtonClass}
                onClick={() =>
                  change({
                    checks: checks.filter((known) => known !== check).length
                      ? checks.filter((known) => known !== check)
                      : null,
                  })
                }
              >
                <Trash2 aria-hidden size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          list="dev-loop-check-names"
          aria-label="Check that counts"
          placeholder={suggestions.length > 0 ? 'Pick or type a check name' : 'Type a check name'}
          className={`${fieldClass} w-64`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add()
          }}
        />
        <datalist id="dev-loop-check-names">
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <button type="button" className={smallGhostButtonClass} onClick={add}>
          Count it
        </button>
      </div>
    </div>
  )
}

const StepFields = ({
  step,
  checkNames,
  change,
}: {
  step: DevLoopStepConfig
  checkNames: readonly string[]
  change: Change
}) => {
  if (step.kind === 'pull_request')
    return (
      <p className="text-sm text-muted">
        Pushes the branch as the chat owner and opens the pull request, or updates the open one.
      </p>
    )
  if (step.kind === 'review')
    return (
      <>
        <p className="text-sm text-muted">
          A subagent with a fresh context reviews the diff against the repository's REVIEW.md and AGENTS.md.
        </p>
        <FailureRule step={step} label={failureLabels.review} change={change} />
      </>
    )
  if (step.kind === 'ci')
    return (
      <>
        <CheckNames checks={step.checks} suggestions={checkNames} change={change} />
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
  pipeline,
  checkNames,
  onChange,
}: {
  pipeline: DevLoopPipeline
  checkNames: readonly string[]
  onChange: (pipeline: DevLoopPipeline) => void
}) => {
  const setSteps = (steps: readonly DevLoopStepConfig[]) => onChange({ ...pipeline, steps })
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Keep each check's logic in a script in the repository, such as a package script or scripts/check.sh: a gate only
        runs it, so developers and agents run the same thing. Every member can read the gates: never put a secret in a
        command.
      </p>
      <ol aria-label="Gates" className="flex flex-col gap-2">
        {pipeline.steps.map((step, index) => {
          const Icon = kindIcons[step.kind]
          const name = step.kind === 'command' && step.name ? step.name : stepKindLabels[step.kind]
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity, and a key from their content would remount the field being typed in
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
                    disabled={withStepMoved(pipeline.steps, index, -1) === pipeline.steps}
                    onClick={() => setSteps(withStepMoved(pipeline.steps, index, -1))}
                  >
                    <ArrowUp aria-hidden size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${name} down`}
                    className={iconButtonClass}
                    disabled={withStepMoved(pipeline.steps, index, 1) === pipeline.steps}
                    onClick={() => setSteps(withStepMoved(pipeline.steps, index, 1))}
                  >
                    <ArrowDown aria-hidden size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    className={iconButtonClass}
                    onClick={() => setSteps(withoutStep(pipeline.steps, index))}
                  >
                    <Trash2 aria-hidden size={14} />
                  </button>
                </span>
              </div>
              <StepFields
                step={step}
                checkNames={checkNames}
                change={(change) => setSteps(withStepChanged(pipeline.steps, index, change))}
              />
            </li>
          )
        })}
      </ol>
      {pipeline.steps.length === 0 && (
        <p className="text-sm text-muted">No gate: the owner reviews the work as it is.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {addableKindsOf(pipeline.steps).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`flex items-center gap-1 ${smallGhostButtonClass}`}
            onClick={() => setSteps(withStep(pipeline.steps, kind))}
          >
            <Plus aria-hidden size={12} />
            {stepKindLabels[kind]}
          </button>
        ))}
      </div>
    </div>
  )
}
