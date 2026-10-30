export type DevLoopSettings = Readonly<{
  checkRounds: number
  reviewRounds: number
  ciRounds: number
  timeLimitMinutes: number
  costLimitMicros: number | null
}>

export const devLoopRange = {
  checkRounds: { minimum: 1, maximum: 10 },
  reviewRounds: { minimum: 0, maximum: 10 },
  ciRounds: { minimum: 0, maximum: 10 },
  timeLimitMinutes: { minimum: 10, maximum: 24 * 60 },
} as const

export const defaultDevLoopSettings: DevLoopSettings = {
  checkRounds: 3,
  reviewRounds: 3,
  ciRounds: 2,
  timeLimitMinutes: 4 * 60,
  costLimitMicros: null,
}

const isWithin = (value: unknown, { minimum, maximum }: { minimum: number; maximum: number }): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum

export const isDevLoopSettings = (value: unknown): value is DevLoopSettings => {
  if (!value || typeof value !== 'object') return false
  const settings = value as Record<string, unknown>
  const { costLimitMicros } = settings
  return (
    (Object.keys(devLoopRange) as (keyof typeof devLoopRange)[]).every((key) =>
      isWithin(settings[key], devLoopRange[key]),
    ) &&
    (costLimitMicros === null || (Number.isSafeInteger(costLimitMicros) && Number(costLimitMicros) > 0))
  )
}

export const devLoopSettingsFrom = (stored: unknown): DevLoopSettings | null =>
  stored && typeof stored === 'object'
    ? (Object.fromEntries(
        Object.entries(defaultDevLoopSettings).map(([key, fallback]) => {
          const value = (stored as Record<string, unknown>)[key]
          return [key, isDevLoopSettings({ ...defaultDevLoopSettings, [key]: value }) ? value : fallback]
        }),
      ) as DevLoopSettings)
    : null
