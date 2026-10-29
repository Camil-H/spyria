import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, globex, type Snapshot } from '@spyria/db'
import { getOnboarding } from './get-onboarding.ts'

const snapshot = createMockSnapshot()
const statesOf = (rows: Snapshot, memberId = alice) =>
  Object.fromEntries(getOnboarding(acme, memberId, true)(rows).tasks.map(({ task, state }) => [task, state]))

test('an admin of the mock workspace has a key and teammates, and nothing else done yet', () => {
  expect(statesOf(snapshot)).toEqual({
    'verify-domain': 'open',
    'connect-github-app': 'open',
    'connect-runtime': 'open',
    'add-ai-key': 'done',
    'invite-members': 'done',
    'add-profile-picture': 'open',
  })
})

test('facts come from synced rows of the same workspace and member only', () => {
  const withOtherRows: Snapshot = {
    ...snapshot,
    ssoDomains: [{ workspaceId: globex, domain: 'globex.test', isVerified: true }],
    githubApps: [{ workspaceId: globex }],
    githubConnections: [{ workspaceId: acme, memberId: bob }],
  }
  expect(statesOf(withOtherRows)).toMatchObject({ 'verify-domain': 'open', 'connect-github-app': 'open' })
  expect(statesOf({ ...withOtherRows, githubApps: [{ workspaceId: acme }] }, bob)['link-github-account']).toBe('done')
})

test('a runtime host counts once it has been claimed, and a member host never does', () => {
  const host = {
    workspaceId: acme,
    name: 'Build box',
    claimExpiresAt: null,
    capacity: null,
    runningRuntimes: 0,
  } as const
  const withHosts = (status: 'waiting' | 'offline', ownerId: typeof bob | null) =>
    statesOf({ ...snapshot, runtimeHosts: [{ ...host, id: 'host-1' as never, status, ownerId }] })['connect-runtime']
  expect(withHosts('waiting', null)).toBe('open')
  expect(withHosts('offline', bob)).toBe('open')
  expect(withHosts('offline', null)).toBe('done')
})

test('workspace records are shared and member records are the member’s own', () => {
  const recorded: Snapshot = {
    ...snapshot,
    workspaceOnboarding: [{ workspaceId: acme, task: 'connect-github-app' }],
    memberOnboarding: [
      { workspaceId: acme, memberId: bob, task: 'connect-runtime', isCompleted: false, isSkipped: true },
      { workspaceId: acme, memberId: alice, task: 'add-profile-picture', isCompleted: false, isSkipped: true },
      { workspaceId: acme, memberId: alice, task: 'not-a-task', isCompleted: true, isSkipped: false },
    ],
  }
  const states = statesOf(recorded)
  expect(states).toMatchObject({ 'connect-github-app': 'done', 'connect-runtime': 'open' })
  expect(states['add-profile-picture']).toBeUndefined()
  expect(getOnboarding(acme, alice, true)(recorded).tasksToRecord).toEqual(['add-ai-key', 'invite-members'])
})
