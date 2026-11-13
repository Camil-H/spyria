import { expect, test } from 'bun:test'
import { retryDelayOf } from './job-worker.ts'

const productionDelays = {
  retryDelayMilliseconds: 1000,
  cleanupRetryDelayMilliseconds: 5000,
  maximumCleanupRetryDelayMilliseconds: 300_000,
}
const delaysOf = (jobType: string) => [1, 2, 3, 4].map((attempt) => retryDelayOf(jobType, attempt, productionDelays))

test.each([
  'workspace.purge',
  'workspace.halt',
  'runtime.stop',
  'runtime.remove',
  'runtime.discard',
  'profile.gateway-sync',
  'profile.tool-server-removal',
])('a failed %s job, which a deleted workspace still runs, retries after 5 s, 25 s, 125 s, then 300 s', (jobType) => {
  expect(delaysOf(jobType)).toEqual([5000, 25_000, 125_000, 300_000])
})

test.each(['agent.prompt', 'runtime.start', 'usage.sync'])(
  'any other failed job, such as %s, retries after 1, 2, 3 then 4 s so a member hears soon that it could not start',
  (jobType) => {
    expect(delaysOf(jobType)).toEqual([1000, 2000, 3000, 4000])
  },
)

test('a capped cleanup delay keeps tests fast without changing the other jobs', () => {
  const testDelays = { ...productionDelays, retryDelayMilliseconds: 100, maximumCleanupRetryDelayMilliseconds: 400 }
  expect([1, 2, 3, 4].map((attempt) => retryDelayOf('runtime.stop', attempt, testDelays))).toEqual([400, 400, 400, 400])
  expect([1, 2, 3, 4].map((attempt) => retryDelayOf('agent.prompt', attempt, testDelays))).toEqual([100, 200, 300, 400])
})
