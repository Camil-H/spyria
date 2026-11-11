import { createHash, timingSafeEqual } from 'node:crypto'

const sha256Of = (text: string) => createHash('sha256').update(text).digest()

export const isSameSecret = (secret: string | undefined, given: unknown) =>
  secret !== undefined && typeof given === 'string' && timingSafeEqual(sha256Of(secret), sha256Of(given))
