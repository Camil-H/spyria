import type { IdGenerator } from '@hq/kernel'

export const createUuidIdGenerator = (): IdGenerator => ({ next: () => crypto.randomUUID() })
