import { expect, test } from 'bun:test'
import { jobTypesOfDeletedWorkspaces } from '@spyria/db/server-writes'
import { createProfileJobs } from '@spyria/profile/server'
import { createRuntimeJobs } from '@spyria/runtime/server'
import { createWorkspaceJobs } from '@spyria/workspace/server'

test('every job a deleted workspace still runs is a job some context handles', () => {
  const handledJobTypes = Object.keys({
    ...createRuntimeJobs({} as never),
    ...createProfileJobs({} as never),
    ...createWorkspaceJobs({ cleanupPollMilliseconds: 1, failedCleanupRetryMilliseconds: 1 }),
  })
  expect(jobTypesOfDeletedWorkspaces.filter((type) => !handledJobTypes.includes(type))).toEqual([])
})
