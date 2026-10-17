import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@hq/kernel'
import { LastAdmin, MemberNotFound, NotWorkspaceAdmin } from './errors.ts'
import { isActive, type Member, requireActiveMember, requireAdmin, requireAnotherAdmin } from './member.ts'

const alice: Member = { workspaceId: workspaceId('acme'), id: memberId('alice'), role: 'admin', removedAt: null }
const bob: Member = { ...alice, id: memberId('bob'), role: 'member' }

test('a removed or missing member is not active, an admin acts only while active', () => {
  expect(isActive(alice)).toBe(true)
  expect(isActive({ ...alice, removedAt: 1 })).toBe(false)
  expect(isActive(undefined)).toBe(false)
  expect(() => requireAdmin(alice)).not.toThrow()
  for (const actor of [bob, { ...alice, removedAt: 1 }, undefined])
    expect(() => requireAdmin(actor)).toThrow(NotWorkspaceAdmin)
  expect(requireActiveMember(bob, bob.id)).toBe(bob)
  expect(() => requireActiveMember({ ...bob, removedAt: 1 }, bob.id)).toThrow(MemberNotFound)
})

test('the last active admin can be neither demoted nor removed, any other member can', () => {
  expect(() => requireAnotherAdmin(alice, [alice.id])).toThrow(LastAdmin)
  expect(() => requireAnotherAdmin(alice, [])).toThrow(LastAdmin)
  expect(() => requireAnotherAdmin(alice, [alice.id, memberId('lee')])).not.toThrow()
  expect(() => requireAnotherAdmin(bob, [alice.id])).not.toThrow()
})
