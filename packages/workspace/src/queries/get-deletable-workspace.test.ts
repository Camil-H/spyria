import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, globex } from '@spyria/db'
import { getDeletableWorkspace } from './get-deletable-workspace.ts'

const snapshot = createMockSnapshot()
const withAliceRemovedFromAcme = {
  ...snapshot,
  memberships: snapshot.memberships.map((membership) =>
    membership.memberId === alice && membership.workspaceId === acme
      ? { ...membership, removedAt: '2026-10-17T00:00:00.000Z' }
      : membership,
  ),
}

test('an active Admin may delete their workspace, nobody else', () => {
  expect(getDeletableWorkspace(acme, alice)(snapshot)?.name).toBe('Acme')
  expect(getDeletableWorkspace(globex, alice)(snapshot)?.name).toBe('Globex')
  expect(getDeletableWorkspace(acme, bob)(snapshot)).toBeUndefined()
  expect(getDeletableWorkspace(acme, alice)(withAliceRemovedFromAcme)).toBeUndefined()
})
