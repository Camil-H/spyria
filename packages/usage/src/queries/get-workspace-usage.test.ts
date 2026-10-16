import { expect, test } from 'bun:test'
import { acme, alice, globex, bob } from '@hq/db'
import { projectId } from '@hq/kernel'
import { getWorkspaceUsage } from './get-workspace-usage.ts'
import { earlier, month, snapshot } from './testing.ts'

test('workspace usage totals the month per member and per project, loose chats under "No project" last', () => {
  expect(getWorkspaceUsage(acme, month)(snapshot)).toEqual({
    months: [month, earlier],
    total: { tokens: 1360, costMicros: 26_000, calls: 5 },
    byMember: [
      { memberId: alice, name: 'Alice', tokens: 1010, costMicros: 20_000, calls: 3 },
      { memberId: bob, name: 'Bob', tokens: 350, costMicros: 6_000, calls: 2 },
    ],
    byProject: [
      { projectId: projectId('project-billing'), name: 'Billing', tokens: 1300, costMicros: 25_000, calls: 3 },
      { projectId: projectId('project-onboarding'), name: 'Onboarding', tokens: 10, costMicros: 0, calls: 1 },
      { projectId: null, name: 'No project', tokens: 50, costMicros: 1_000, calls: 1 },
    ],
  })
  expect(getWorkspaceUsage(acme, earlier)(snapshot)).toMatchObject({
    total: { tokens: 7, costMicros: 70, calls: 7 },
    byProject: [{ name: 'Billing', calls: 7 }],
  })
  expect(getWorkspaceUsage(globex, earlier)(snapshot)).toEqual({
    months: [month],
    total: { tokens: 0, costMicros: 0, calls: 0 },
    byMember: [],
    byProject: [],
  })
})
