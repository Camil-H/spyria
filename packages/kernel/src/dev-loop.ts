export type DevLoopStepConfig =
  | Readonly<{ kind: 'command'; name: string; command: string; timeoutMinutes: number; fixes: number }>
  | Readonly<{ kind: 'review'; fixes: number }>
  | Readonly<{ kind: 'pull_request' }>
  | Readonly<{ kind: 'ci'; checks: readonly string[] | null; fixes: number }>
export type DevLoopStepKind = DevLoopStepConfig['kind']
export type DevLoopPipeline = Readonly<{
  repository: string | null
  steps: readonly DevLoopStepConfig[]
}>
export type DevLoopSettings = Readonly<{
  isOn: boolean
  timeLimitMinutes: number
  costLimitMicros: number | null
  pipelines: readonly DevLoopPipeline[]
}>

export const devLoopRange = {
  fixes: { minimum: 0, maximum: 10 },
  timeoutMinutes: { minimum: 1, maximum: 120 },
  timeLimitMinutes: { minimum: 10, maximum: 24 * 60 },
} as const
const maximumSteps = 20
const maximumNameLength = 60
const maximumCommandLength = 2_000
const singleKinds: DevLoopStepKind[] = ['review', 'pull_request', 'ci']

export const defaultDevLoopPipeline: DevLoopPipeline = {
  repository: null,
  steps: [{ kind: 'review', fixes: 2 }, { kind: 'pull_request' }, { kind: 'ci', checks: null, fixes: 2 }],
}

export const defaultDevLoopSettings: DevLoopSettings = {
  isOn: true,
  timeLimitMinutes: 4 * 60,
  costLimitMicros: null,
  pipelines: [defaultDevLoopPipeline],
}

const isWithin = (value: unknown, { minimum, maximum }: { minimum: number; maximum: number }): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum

const isText = (value: unknown, maximumLength: number) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maximumLength

const isStep = (value: unknown): value is DevLoopStepConfig => {
  const step = (value ?? {}) as Record<string, unknown>
  if (step.kind === 'pull_request') return true
  if (!isWithin(step.fixes, devLoopRange.fixes)) return false
  if (step.kind === 'review') return true
  if (step.kind === 'ci')
    return step.checks === null || (Array.isArray(step.checks) && step.checks.every((name) => isText(name, 200)))
  return (
    step.kind === 'command' &&
    isText(step.name, maximumNameLength) &&
    isText(step.command, maximumCommandLength) &&
    isWithin(step.timeoutMinutes, devLoopRange.timeoutMinutes)
  )
}

const kindIndexOf = (steps: readonly DevLoopStepConfig[], kind: DevLoopStepKind) =>
  steps.findIndex((step) => step.kind === kind)

export const isInPublishingOrder = (steps: readonly DevLoopStepConfig[]) => {
  const pullRequest = kindIndexOf(steps, 'pull_request')
  const ci = kindIndexOf(steps, 'ci')
  const afterPublishing = pullRequest === -1 ? [] : steps.slice(pullRequest + 1)
  return afterPublishing.every((step) => step.kind === 'ci') && (ci === -1 || (pullRequest !== -1 && ci > pullRequest))
}

const isPipeline = (value: unknown): value is DevLoopPipeline => {
  const { repository, steps } = (value ?? {}) as Record<string, unknown>
  if (repository !== null && !isText(repository, 200)) return false
  if (!Array.isArray(steps) || steps.length > maximumSteps || !steps.every(isStep)) return false
  const isSingle = singleKinds.every((kind) => steps.filter((step) => step.kind === kind).length <= 1)
  const names = steps.flatMap((step) => (step.kind === 'command' ? [step.name.trim().toLowerCase()] : []))
  return isSingle && new Set(names).size === names.length && isInPublishingOrder(steps)
}

export const isDevLoopSettings = (value: unknown): value is DevLoopSettings => {
  if (!value || typeof value !== 'object') return false
  const { isOn, timeLimitMinutes, costLimitMicros, pipelines } = value as Record<string, unknown>
  if (typeof isOn !== 'boolean' || !isWithin(timeLimitMinutes, devLoopRange.timeLimitMinutes)) return false
  if (costLimitMicros !== null && !(Number.isSafeInteger(costLimitMicros) && Number(costLimitMicros) > 0)) return false
  if (!Array.isArray(pipelines) || !pipelines.every(isPipeline)) return false
  const repositories = pipelines.map((pipeline) => pipeline.repository)
  return new Set(repositories).size === repositories.length
}

export const devLoopSettingsFrom = (stored: unknown): DevLoopSettings | null =>
  isDevLoopSettings(stored) ? stored : null

export const pipelineOf = (settings: DevLoopSettings | null, repository: string | null) =>
  settings?.pipelines.find((pipeline) => pipeline.repository === repository) ??
  settings?.pipelines.find((pipeline) => pipeline.repository === null) ??
  defaultDevLoopPipeline

export type SetupCommand = Readonly<{ repository: string | null; command: string }>
const maximumSetupCommands = 100

export const isSetupCommands = (value: unknown): value is readonly SetupCommand[] => {
  if (!Array.isArray(value) || value.length > maximumSetupCommands) return false
  const isEach = value.every((setup) => {
    const { repository, command } = (setup ?? {}) as Record<string, unknown>
    return (repository === null || isText(repository, 200)) && isText(command, maximumCommandLength)
  })
  return isEach && new Set(value.map(({ repository }) => repository)).size === value.length
}

export const setupCommandsFrom = (stored: unknown) => (isSetupCommands(stored) ? stored : [])

export const setupCommandOf = (commands: readonly SetupCommand[], repository: string | null) =>
  commands.find((setup) => setup.repository === repository)?.command ??
  commands.find((setup) => setup.repository === null)?.command ??
  null
