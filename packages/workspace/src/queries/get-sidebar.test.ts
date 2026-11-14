import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, lee } from '@spyria/db'
import { chatId, type MemberId } from '@spyria/kernel'
import { withChat } from '../domain/testing.ts'
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
    withChat(withChat(createMockSnapshot(), { name: 'Lounge', visibility: 'public', participantIds }), {
      name: 'Backroom',
      visibility: 'private',
      participantIds,
    })
  expect(sidebarChatsOf(lee, lounge([])).map(({ name }) => name)).toEqual(['Invoice bug'])
  expect(sidebarChatsOf(lee, lounge([lee])).map(({ name }) => name)).toEqual(['Invoice bug', 'Lounge', 'Backroom'])
})

test("the sidebar follows the viewer's own order, with the chats they never placed after it in creation order", () => {
  const withLounges = ['Lounge', 'Backroom', 'Annex'].reduce(
    (snapshot, name) => withChat(snapshot, { name, visibility: 'private', participantIds: [lee] }),
    createMockSnapshot(),
  )
  const placedByLee = {
    ...withLounges,
    chatMembers: withLounges.chatMembers.map((row) =>
      row.memberId === lee && row.chatId === chatId('chat-annex') ? { ...row, sidebarPosition: 0 } : row,
    ),
  }
  const looseChatNamesOf = (viewerId: MemberId) =>
    getSidebar(acme, viewerId)(placedByLee).looseChats.map(({ name }) => name)
  expect(looseChatNamesOf(lee)).toEqual(['Annex', 'Lounge', 'Backroom'])
  expect(looseChatNamesOf(bob)).toEqual(['Standup', 'Lounge', 'Backroom', 'Annex'])
})
