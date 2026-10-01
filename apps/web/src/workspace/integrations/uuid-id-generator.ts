import type { IdGenerator } from '../contracts/id-generator.ts'

export const createUuidIdGenerator = (): IdGenerator => ({ next: () => crypto.randomUUID() })
