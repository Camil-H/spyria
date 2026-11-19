import type { askerOf } from './flags.ts'

export type Asker = ReturnType<typeof askerOf> & { isUnattended: boolean }

export const removal = '-'
