import { expect, test } from 'bun:test'
import { MemberNotFound, memberId, workspaceId } from '@spyria/kernel'
import { AdminOnly, LastAdmin, OwnMembership } from './errors.ts'
import {
  isActive,
  type Member,
  requireActiveMember,
  requireAdmin,
  requireAnotherAdmin,
  requireAnotherMember,
} from './member.ts'

const alice: Member = { workspaceId: workspaceId('acme'), id: memberId('alice'), role: 'admin', removedAt: null }
const bob: Member = { ...alice, id: memberId('bob'), role: 'member' }

test('a removed or missing member is not active', () => {
  expect(isActive(alice)).toBe(true)
  expect(isActive({ ...alice, removedAt: 1 })).toBe(false)
  expect(isActive(undefined)).toBe(false)
  expect(requireActiveMember(bob, bob.id)).toBe(bob)
  expect(() => requireActiveMember({ ...bob, removedAt: 1 }, bob.id)).toThrow(MemberNotFound)
})

test('the last active admin can be neither demoted nor removed, any other member can', () => {
  expect(() => requireAnotherAdmin(alice, [alice.id])).toThrow(LastAdmin)
  expect(() => requireAnotherAdmin(alice, [])).toThrow(LastAdmin)
  expect(() => requireAnotherAdmin(alice, [alice.id, memberId('lee')])).not.toThrow()
  expect(() => requireAnotherAdmin(bob, [alice.id])).not.toThrow()
})

test('nobody changes or removes their own membership', () => {
  expect(() => requireAnotherMember(alice.id, alice.id)).toThrow(OwnMembership)
  expect(() => requireAnotherMember(bob.id, alice.id)).not.toThrow()
})

test('only an active Admin passes the Admin check', () => {
  expect(requireAdmin(alice)).toBe(alice)
  expect(() => requireAdmin(bob)).toThrow(AdminOnly)
  expect(() => requireAdmin({ ...alice, removedAt: 1 })).toThrow(AdminOnly)
  expect(() => requireAdmin(undefined)).toThrow(AdminOnly)
})
