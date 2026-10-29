import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, globex, lee } from '@spyria/db'
import type { MemberId } from '@spyria/kernel'
import { withChat } from '../domain/testing.ts'
import { type JoinableChat, listJoinableChats } from './list-joinable-chats.ts'

const addedChats: Parameters<typeof withChat>[1][] = [
  { name: 'Lounge', visibility: 'public', participantIds: [alice] },
  { name: 'Backroom', visibility: 'private' },
  { name: 'Archived', visibility: 'public' },
  { name: 'Forecasts', visibility: 'public', type: 'runtime' },
  { name: 'Drafts', visibility: 'private', type: 'runtime' },
]
const snapshot = addedChats.reduce(withChat, createMockSnapshot())
const withArchived = {
  ...snapshot,
  chats: snapshot.chats.map((chat) => (chat.name === 'Archived' ? { ...chat, archived: true } : chat)),
}

test.each<[string, MemberId, Omit<JoinableChat, 'id'>[]]>([
  [
    'Lee',
    lee,
    [
      { type: 'channel', name: 'Welcome', projectName: 'Onboarding', memberCount: 2 },
      { type: 'channel', name: 'Standup', projectName: null, memberCount: 2 },
      { type: 'channel', name: 'Lounge', projectName: null, memberCount: 2 },
      { type: 'runtime', name: 'Forecasts', projectName: null, memberCount: 1 },
    ],
  ],
  ['Alice', alice, [{ type: 'runtime', name: 'Forecasts', projectName: null, memberCount: 1 }]],
  ['Bob', bob, []],
])(
  'Browse lists the public chats %s has not joined, AI chats included, with project and member count',
  (_, viewerId, chats) => {
    expect(listJoinableChats(acme, viewerId)(withArchived).map(({ id, ...chat }) => chat)).toEqual(chats)
  },
)

test('Browse lists only the chats of the given workspace', () => {
  expect(listJoinableChats(globex, lee)(withArchived).map(({ name }) => name)).toEqual(['General'])
})
