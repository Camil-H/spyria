import { CircleCheck, CircleX, IterationCw } from 'lucide-react'
import type { DevLoopState, DevLoopStep } from '../domain/dev-loop.ts'

const stateLabels: Record<DevLoopState, string> = {
  working: 'Agent working',
  checking: 'Running checks',
  reviewing: 'Reviewing',
  publishing: 'Publishing',
  waiting_for_ci: 'Waiting for CI',
  handing_off: 'Handing over',
  done: 'Done',
  stopped: 'Stopped',
}
const stateClasses: Record<DevLoopState, string> = {
  working: 'bg-hover text-muted',
  checking: 'bg-hover text-muted',
  reviewing: 'bg-hover text-muted',
  publishing: 'bg-hover text-muted',
  waiting_for_ci: 'bg-hover text-muted',
  handing_off: 'bg-removed text-ink',
  done: 'bg-added text-ink',
  stopped: 'bg-removed text-ink',
}

const roundsOf = ({ rounds, limits }: DevLoopStep) =>
  [
    `Checks fixed ${rounds.checks} of ${limits.checkRounds}`,
    limits.reviewRounds > 0 && `review ${rounds.review} of ${limits.reviewRounds}`,
    limits.ciRounds > 0 && `CI ${rounds.ci} of ${limits.ciRounds}`,
  ]
    .filter(Boolean)
    .join(' · ')

const DevLoopCard = ({ step }: { step: DevLoopStep }) => {
  const important = step.findings.filter((finding) => finding.severity === 'important').length
  return (
    <section aria-label="Dev loop" className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <IterationCw aria-hidden size={16} className="shrink-0 text-muted" />
        <span className="font-medium">{step.summary.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${stateClasses[step.state]}`}>
          {stateLabels[step.state]}
        </span>
      </div>
      {step.checks.length > 0 && (
        <ul aria-label="Checks" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {step.checks.map(({ name, passed }) => (
            <li key={name} className="flex items-center gap-1">
              {passed ? (
                <CircleCheck role="img" aria-label="passed" size={14} className="text-muted" />
              ) : (
                <CircleX role="img" aria-label="failed" size={14} className="text-muted" />
              )}
              {name}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        {roundsOf(step)}
        {step.findings.length > 0 &&
          ` · ${step.findings.length} review ${step.findings.length === 1 ? 'finding' : 'findings'}, ${important} important`}
        {step.pullRequestNumber !== null && ` · pull request #${step.pullRequestNumber}`}
      </p>
      {step.outcome && <p>{step.outcome}</p>}
    </section>
  )
}

export default DevLoopCard
