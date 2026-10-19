import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, lee } from '@spyria/db'
import type { MemberId } from '@spyria/kernel'
import { withChannel } from '../domain/testing.ts'
import { getSidebar } from './get-sidebar.ts'

const sidebarChatsOf = (viewerId: MemberId, snapshot = createMockSnapshot()) => {
  const sidebar = getSidebar(acme, viewerId)(snapshot)
  return [...sidebar.projects.flatMap((project) => project.chats), ...sidebar.looseChats].map(
    ({ name, canAdmin, canLeave }) => ({ name, canAdmin, canLeave }),
  )
}

test.each([
  [
    'Alice',
    alice,
    [
      { name: 'Welcome', canAdmin: true, canLeave: false },
      { name: 'Setup helper', canAdmin: false, canLeave: true },
      { name: 'Invoice bug', canAdmin: true, canLeave: false },
      { name: 'Standup', canAdmin: false, canLeave: true },
      { name: 'Research', canAdmin: true, canLeave: false },
    ],
  ],
  [
    'Bob',
    bob,
    [
      { name: 'Welcome', canAdmin: false, canLeave: true },
      { name: 'Setup helper', canAdmin: true, canLeave: false },
      { name: 'Invoice bug', canAdmin: false, canLeave: true },
      { name: 'Standup', canAdmin: true, canLeave: false },
    ],
  ],
  ['Lee', lee, [{ name: 'Invoice bug', canAdmin: false, canLeave: true }]],
])('the sidebar lists only the chats %s is a participant of', (_, viewerId, chats) => {
  expect(sidebarChatsOf(viewerId)).toEqual(chats)
})

test('a public channel joins the sidebar when the member becomes a participant, a private one too', () => {
  const lounge = (participantIds: MemberId[]) =>
    withChannel(withChannel(createMockSnapshot(), { name: 'Lounge', visibility: 'public', participantIds }), {
      name: 'Backroom',
      visibility: 'private',
      participantIds,
    })
  expect(sidebarChatsOf(lee, lounge([])).map(({ name }) => name)).toEqual(['Invoice bug'])
  expect(sidebarChatsOf(lee, lounge([lee])).map(({ name }) => name)).toEqual(['Invoice bug', 'Lounge', 'Backroom'])
})
