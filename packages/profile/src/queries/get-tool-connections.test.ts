import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot } from '@spyria/db'
import { countConnectionStates } from './get-tool-connections.ts'

const snapshot = createMockSnapshot()
const countsWith = (needsReconnection: boolean) =>
  countConnectionStates(
    acme,
    alice,
  )({
    ...snapshot,
    githubConnections: [
      { workspaceId: acme, memberId: alice, needsReconnection },
      { workspaceId: acme, memberId: bob, needsReconnection: false },
    ],
  })

test('counts my GitHub account as connected, and as to reconnect once it needs reconnection', () => {
  const withoutGitHub = countConnectionStates(acme, alice)({ ...snapshot, githubConnections: [] })
  expect(countsWith(false)).toEqual({ ...withoutGitHub, connected: withoutGitHub.connected + 1 })
  expect(countsWith(true)).toEqual({ ...withoutGitHub, toReconnect: withoutGitHub.toReconnect + 1 })
})
