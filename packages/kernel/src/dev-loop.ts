export type DevLoopStepConfig =
  | Readonly<{ kind: 'command'; name: string; command: string; timeoutMinutes: number; fixes: number }>
  | Readonly<{ kind: 'review'; fixes: number }>
  | Readonly<{ kind: 'pull_request' }>
  | Readonly<{ kind: 'ci'; fixes: number }>
export type DevLoopStepKind = DevLoopStepConfig['kind']
export type DevLoopRules = Readonly<{
  repository: string | null
  isOn: boolean
  timeLimitMinutes: number
  costLimitMicros: number | null
  steps: readonly DevLoopStepConfig[]
}>
export type DevLoopSettings = Readonly<{ rules: readonly DevLoopRules[] }>

export const devLoopRange = {
  fixes: { minimum: 0, maximum: 10 },
  timeoutMinutes: { minimum: 1, maximum: 120 },
  timeLimitMinutes: { minimum: 10, maximum: 24 * 60 },
} as const
const maximumSteps = 20
const maximumNameLength = 60
const maximumCommandLength = 2_000
const maximumRepositoryLength = 200
const singleKinds: DevLoopStepKind[] = ['review', 'pull_request', 'ci']

export const defaultDevLoopRules: DevLoopRules = {
  repository: null,
  isOn: false,
  timeLimitMinutes: 4 * 60,
  costLimitMicros: null,
  steps: [{ kind: 'review', fixes: 2 }, { kind: 'pull_request' }, { kind: 'ci', fixes: 2 }],
}

export const defaultDevLoopSettings: DevLoopSettings = { rules: [defaultDevLoopRules] }

const isWithin = (value: unknown, { minimum, maximum }: { minimum: number; maximum: number }): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum

const isText = (value: unknown, maximumLength: number) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maximumLength

const isStep = (value: unknown): value is DevLoopStepConfig => {
  const step = (value ?? {}) as Record<string, unknown>
  if (step.kind === 'pull_request') return true
  if (!isWithin(step.fixes, devLoopRange.fixes)) return false
  if (step.kind === 'review' || step.kind === 'ci') return true
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

export const isDevLoopRules = (value: unknown): value is DevLoopRules => {
  const { repository, isOn, timeLimitMinutes, costLimitMicros, steps } = (value ?? {}) as Record<string, unknown>
  if (repository !== null && !isText(repository, maximumRepositoryLength)) return false
  if (typeof isOn !== 'boolean' || !isWithin(timeLimitMinutes, devLoopRange.timeLimitMinutes)) return false
  if (costLimitMicros !== null && !(Number.isSafeInteger(costLimitMicros) && Number(costLimitMicros) > 0)) return false
  if (!Array.isArray(steps) || steps.length > maximumSteps || !steps.every(isStep)) return false
  const isSingle = singleKinds.every((kind) => steps.filter((step) => step.kind === kind).length <= 1)
  const names = steps.flatMap((step) => (step.kind === 'command' ? [step.name.trim().toLowerCase()] : []))
  return isSingle && new Set(names).size === names.length && isInPublishingOrder(steps)
}

export const isDevLoopSettings = (value: unknown): value is DevLoopSettings => {
  const { rules } = (value ?? {}) as Record<string, unknown>
  if (!Array.isArray(rules) || !rules.every(isDevLoopRules)) return false
  const repositories = rules.map((known) => known.repository)
  return new Set(repositories).size === repositories.length
}

export const devLoopSettingsFrom = (stored: unknown): DevLoopSettings | null =>
  isDevLoopSettings(stored) ? stored : null

export const rulesOf = (settings: DevLoopSettings | null, repository: string | null) =>
  settings?.rules.find((known) => known.repository === repository) ??
  settings?.rules.find((known) => known.repository === null) ??
  defaultDevLoopRules

export const isAnyRuleOn = (settings: DevLoopSettings | null) => settings?.rules.some(({ isOn }) => isOn) ?? false

export type SetupCommand = Readonly<{ repository: string | null; command: string }>
const maximumSetupCommands = 100

export const isSetupCommands = (value: unknown): value is readonly SetupCommand[] => {
  if (!Array.isArray(value) || value.length > maximumSetupCommands) return false
  const isEach = value.every((setup) => {
    const { repository, command } = (setup ?? {}) as Record<string, unknown>
    return (repository === null || isText(repository, maximumRepositoryLength)) && isText(command, maximumCommandLength)
  })
  return isEach && new Set(value.map(({ repository }) => repository)).size === value.length
}

export const setupCommandsFrom = (stored: unknown) => (isSetupCommands(stored) ? stored : [])

export const setupCommandOf = (commands: readonly SetupCommand[], repository: string | null) =>
  commands.find((setup) => setup.repository === repository)?.command ??
  commands.find((setup) => setup.repository === null)?.command ??
  null
