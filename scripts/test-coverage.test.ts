import { expect, test } from 'bun:test'
import { areaOf, compareCoverage, coveredLinesOfLcov, formatCoveredLines, parseCoveredLines } from './test-coverage.ts'

const lcov = [
  'SF:apps/server/src/auth/sso.ts',
  'DA:1,1',
  'DA:2,3',
  'DA:3,1',
  'DA:5,0',
  'DA:7,2',
  'end_of_record',
  'SF:apps/server/src/auth/sso.test.ts',
  'DA:1,1',
  'end_of_record',
  'SF:apps/server/src/testing/fake-llm.ts',
  'DA:1,1',
  'end_of_record',
].join('\n')

test('covered lines leave out tests, test helpers and lines never run, and survive a round trip through the baseline file', () => {
  const covered = coveredLinesOfLcov(lcov)
  expect(formatCoveredLines(covered)).toBe('apps/server/src/auth/sso.ts: 1-3,7\n')
  expect(parseCoveredLines(formatCoveredLines(covered))).toEqual(covered)
})

test('a line the baseline covered and the current run misses is lost, and counts are kept per area', () => {
  const baseline = parseCoveredLines('apps/server/src/auth/sso.ts: 1-3,7\npackages/kernel/src/ids.ts: 4\n')
  const current = parseCoveredLines('apps/server/src/auth/sso.ts: 1-3,8-9\npackages/kernel/src/ids.ts: 4\n')
  expect(compareCoverage(baseline, current)).toEqual({
    lost: [{ file: 'apps/server/src/auth/sso.ts', lines: new Set([7]) }],
    moved: [],
    areas: [
      { area: 'apps/server/src/auth', baseline: 4, current: 5 },
      { area: 'packages/kernel', baseline: 1, current: 1 },
    ],
  })
})

test('a line the layer no longer covers but another layer does has moved, not been lost', () => {
  const baseline = parseCoveredLines('apps/server/src/llm-relay.ts: 10-12\n')
  const current = parseCoveredLines('apps/server/src/llm-relay.ts: 10\n')
  const otherLayers = parseCoveredLines('apps/server/src/llm-relay.ts: 11\n')
  const { lost, moved } = compareCoverage(baseline, current, otherLayers)
  expect(moved).toEqual([{ file: 'apps/server/src/llm-relay.ts', lines: new Set([11]) }])
  expect(lost).toEqual([{ file: 'apps/server/src/llm-relay.ts', lines: new Set([12]) }])
})

test('an area is a server folder, the server root, or a workspace package', () => {
  expect(areaOf('apps/server/src/agent-bridge/pi.ts')).toBe('apps/server/src/agent-bridge')
  expect(areaOf('apps/server/src/app.ts')).toBe('apps/server/src')
  expect(areaOf('packages/conversation/src/domain/message.ts')).toBe('packages/conversation')
  expect(areaOf('apps/agent/browser/network-policy.mjs')).toBe('apps/agent')
})
