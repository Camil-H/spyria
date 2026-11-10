import { expect, test } from 'bun:test'
import { unitTestOfScript } from './script-tests.ts'

const existing = new Set(['scripts/check-licenses.ts', 'scripts/check-licenses.test.ts', 'scripts/check-tofu.ts'])
const exists = (file: string) => existing.has(file)

test('a changed script selects its own unit test, and a changed test selects itself', () => {
  expect(unitTestOfScript('scripts/check-licenses.ts', exists)).toBe('scripts/check-licenses.test.ts')
  expect(unitTestOfScript('scripts/check-licenses.test.ts', exists)).toBe('scripts/check-licenses.test.ts')
})

test('a script without a unit test, or a file outside scripts, selects none', () => {
  expect(unitTestOfScript('scripts/check-tofu.ts', exists)).toBeUndefined()
  expect(unitTestOfScript('apps/cli/src/cloud.ts', exists)).toBeUndefined()
})
