import { expect, test } from 'bun:test'
import { adminRoleId, memberId, workspaceId } from '@spyria/kernel'
import { founderMembership } from './workspace.ts'

test('the member who creates a workspace joins it as its Admin', () => {
  expect(founderMembership(workspaceId('workspace-new'), memberId('member-bob'))).toEqual({
    workspaceId: workspaceId('workspace-new'),
    memberId: memberId('member-bob'),
    role: adminRoleId,
  })
})
