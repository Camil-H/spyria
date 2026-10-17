import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, globex, lee, bob } from '@hq/db'
import { withChannel } from '../domain/testing.ts'
import { listJoinableChannels } from './list-joinable-channels.ts'

const snapshot = withChannel(
  withChannel(withChannel(createMockSnapshot(), { name: 'Lounge', visibility: 'public', participantIds: [alice] }), {
    name: 'Backroom',
    visibility: 'private',
  }),
  { name: 'Archived', visibility: 'public' },
)
const withArchived = {
  ...snapshot,
  chats: snapshot.chats.map((chat) => (chat.name === 'Archived' ? { ...chat, archived: true } : chat)),
}

test.each([
  [
    'Lee',
    lee,
    [
      { name: 'Welcome', projectName: 'Onboarding', memberCount: 2 },
      { name: 'Standup', projectName: null, memberCount: 2 },
      { name: 'Lounge', projectName: null, memberCount: 2 },
    ],
  ],
  ['Alice', alice, []],
  ['Bob', bob, []],
])('Browse lists the public channels %s has not joined, with project and member count', (_, viewerId, channels) => {
  expect(listJoinableChannels(acme, viewerId)(withArchived).map(({ id, ...channel }) => channel)).toEqual(channels)
})

test('Browse lists only the channels of the given workspace', () => {
  expect(listJoinableChannels(globex, lee)(withArchived).map(({ name }) => name)).toEqual(['General'])
})
