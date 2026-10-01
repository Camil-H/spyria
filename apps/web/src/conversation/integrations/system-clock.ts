import type { Clock } from '../contracts/clock.ts'

export const createSystemClock = (): Clock => ({ now: () => new Date() })
