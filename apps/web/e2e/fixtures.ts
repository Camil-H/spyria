import { test as memoryTest } from '@playwright/test'
import { test as zeroStackTest } from '../e2e-zero/stack.ts'

export * from '@playwright/test'

export const test = process.env.HQ_E2E_DATA === 'zero' ? (zeroStackTest as unknown as typeof memoryTest) : memoryTest
