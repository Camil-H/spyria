import type { DevLoopPipeline, DevLoopSettings, DevLoopStepConfig, DevLoopStepKind } from '@spyria/kernel'

export const stepKindLabels: Record<DevLoopStepKind, string> = {
  command: 'Command',
  review: 'Code review',
  pull_request: 'Pull request',
  ci: 'CI',
}
const singleKinds: DevLoopStepKind[] = ['review', 'pull_request', 'ci']

export const newStepOf = (kind: DevLoopStepKind): DevLoopStepConfig =>
  kind === 'command'
    ? { kind, name: '', command: '', timeoutMinutes: 15, fixes: 3 }
    : kind === 'review'
      ? { kind, fixes: 2 }
      : kind === 'ci'
        ? { kind, checks: null, fixes: 2 }
        : { kind }

export const addableKindsOf = (steps: readonly DevLoopStepConfig[]) =>
  (Object.keys(stepKindLabels) as DevLoopStepKind[]).filter(
    (kind) =>
      !(singleKinds.includes(kind) && steps.some((step) => step.kind === kind)) &&
      (kind !== 'ci' || steps.some((step) => step.kind === 'pull_request')),
  )

export const withStep = (steps: readonly DevLoopStepConfig[], kind: DevLoopStepKind) => {
  const publishing = steps.findIndex((step) => step.kind === (kind === 'pull_request' ? 'ci' : 'pull_request'))
  const at = kind === 'ci' || publishing === -1 ? steps.length : publishing
  return [...steps.slice(0, at), newStepOf(kind), ...steps.slice(at)]
}

export const withStepMoved = (steps: readonly DevLoopStepConfig[], index: number, offset: -1 | 1) => {
  const target = index + offset
  if (target < 0 || target >= steps.length) return steps
  const moved = [...steps]
  ;[moved[index], moved[target]] = [moved[target] as DevLoopStepConfig, moved[index] as DevLoopStepConfig]
  return moved
}

export const withStepChanged = (
  steps: readonly DevLoopStepConfig[],
  index: number,
  change: Partial<Record<string, unknown>>,
) => steps.map((step, at) => (at === index ? ({ ...step, ...change } as DevLoopStepConfig) : step))

export const withoutStep = (steps: readonly DevLoopStepConfig[], index: number) =>
  steps.filter((step, at) => at !== index && !(step.kind === 'ci' && steps[index]?.kind === 'pull_request'))

export const withPipeline = (settings: DevLoopSettings, pipeline: DevLoopPipeline) => ({
  ...settings,
  pipelines: settings.pipelines.some((known) => known.repository === pipeline.repository)
    ? settings.pipelines.map((known) => (known.repository === pipeline.repository ? pipeline : known))
    : [...settings.pipelines, pipeline],
})

export const withoutPipeline = (settings: DevLoopSettings, repository: string) => ({
  ...settings,
  pipelines: settings.pipelines.filter((pipeline) => pipeline.repository !== repository),
})
