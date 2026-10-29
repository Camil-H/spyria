import { expect, test } from 'bun:test'
import { workspacePermissions } from '@spyria/kernel'
import {
  nextTaskOf,
  type OnboardingFacts,
  type OnboardingRecords,
  type OnboardingTask,
  tasksToRecordOf,
  taskViewsOf,
  type Viewer,
} from './tasks.ts'

const nothingDone: OnboardingFacts = {
  isDomainVerified: false,
  hasGitHubApp: false,
  hasClaimedRuntimeHost: false,
  hasInvitedSomeone: false,
  hasAiKey: false,
  hasGitHubAccount: false,
  hasProfilePicture: false,
}
const noRecords: OnboardingRecords = { completed: new Set(), skipped: new Set() }
const admin: Viewer = { permissions: workspacePermissions, usesSingleSignOn: true }
const member: Viewer = { permissions: [], usesSingleSignOn: true }

const recordsOf = (completed: OnboardingTask[], skipped: OnboardingTask[] = []): OnboardingRecords => ({
  completed: new Set(completed),
  skipped: new Set(skipped),
})
const statesOf = (facts: OnboardingFacts, records: OnboardingRecords, viewer: Viewer) =>
  Object.fromEntries(taskViewsOf(facts, records, viewer).map(({ task, state }) => [task, state]))

test('an admin of a new single sign-on workspace sees the workspace tasks first, invites blocked until the domain is verified', () => {
  expect(taskViewsOf(nothingDone, noRecords, admin)).toEqual([
    { task: 'verify-domain', scope: 'workspace', state: 'open' },
    { task: 'connect-github-app', scope: 'workspace', state: 'open' },
    { task: 'connect-runtime', scope: 'workspace', state: 'open' },
    { task: 'add-ai-key', scope: 'member', state: 'open' },
    { task: 'invite-members', scope: 'workspace', state: 'blocked' },
    { task: 'add-profile-picture', scope: 'member', state: 'open' },
  ])
})

test('a member without workspace permissions sees only their personal tasks', () => {
  expect(taskViewsOf(nothingDone, noRecords, member).map(({ task }) => task)).toEqual([
    'add-ai-key',
    'add-profile-picture',
  ])
})

test('each workspace task is shown only to members holding its permission', () => {
  const inviter: Viewer = { permissions: ['members.invite'], usesSingleSignOn: true }
  expect(taskViewsOf(nothingDone, noRecords, inviter).map(({ task }) => task)).toEqual([
    'add-ai-key',
    'invite-members',
    'add-profile-picture',
  ])
})

test('without single sign-on there is no domain to verify and invites are never blocked', () => {
  const states = statesOf(nothingDone, noRecords, { ...admin, usesSingleSignOn: false })
  expect(states['verify-domain']).toBeUndefined()
  expect(states['invite-members']).toBe('open')
})

test('a verified domain unblocks invites', () => {
  expect(statesOf({ ...nothingDone, isDomainVerified: true }, noRecords, admin)['invite-members']).toBe('open')
  expect(statesOf(nothingDone, recordsOf(['verify-domain']), admin)['invite-members']).toBe('open')
})

test('linking a GitHub account is shown once the workspace has had a GitHub App', () => {
  expect(statesOf(nothingDone, noRecords, member)['link-github-account']).toBeUndefined()
  expect(statesOf({ ...nothingDone, hasGitHubApp: true }, noRecords, member)['link-github-account']).toBe('open')
  expect(statesOf(nothingDone, recordsOf(['connect-github-app']), member)['link-github-account']).toBe('open')
})

test('a recorded task stays done after its condition goes back', () => {
  expect(statesOf(nothingDone, recordsOf(['connect-github-app', 'add-ai-key']), admin)).toMatchObject({
    'connect-github-app': 'done',
    'add-ai-key': 'done',
  })
})

test('a skipped task is no longer listed, even once done', () => {
  const states = statesOf(
    { ...nothingDone, hasAiKey: true, hasGitHubApp: true },
    recordsOf([], ['add-ai-key', 'add-profile-picture']),
    member,
  )
  expect(states).toEqual({ 'link-github-account': 'open' })
})

test('skipping the domain verification keeps invites blocked, and skipping them too clears the workspace tasks', () => {
  const allButDomainDone = { ...nothingDone, hasGitHubApp: true, hasClaimedRuntimeHost: true }
  const workspaceStatesOf = (skipped: OnboardingTask[]) =>
    taskViewsOf(allButDomainDone, recordsOf([], skipped), admin)
      .filter(({ scope }) => scope === 'workspace')
      .map(({ task, state }) => [task, state])
  expect(workspaceStatesOf(['verify-domain'])).toEqual([
    ['connect-github-app', 'done'],
    ['connect-runtime', 'done'],
    ['invite-members', 'blocked'],
  ])
  expect(workspaceStatesOf(['verify-domain', 'invite-members'])).toEqual([
    ['connect-github-app', 'done'],
    ['connect-runtime', 'done'],
  ])
})

test('the next task is the first open one, past blocked, done and skipped tasks', () => {
  const views = taskViewsOf(
    { ...nothingDone, hasGitHubApp: true },
    recordsOf([], ['verify-domain', 'connect-runtime']),
    admin,
  )
  expect(nextTaskOf(views)).toBe('add-ai-key')
  expect(nextTaskOf(taskViewsOf(nothingDone, recordsOf([], ['add-ai-key', 'add-profile-picture']), member))).toBe(
    undefined,
  )
})

test('only met conditions that are not yet recorded and that the member may do are recorded', () => {
  const allMet: OnboardingFacts = Object.fromEntries(
    Object.keys(nothingDone).map((fact) => [fact, true]),
  ) as unknown as OnboardingFacts
  expect(tasksToRecordOf(allMet, recordsOf(['add-ai-key']), [])).toEqual(['link-github-account', 'add-profile-picture'])
  expect(tasksToRecordOf({ ...nothingDone, hasGitHubApp: true }, noRecords, ['github.manage'])).toEqual([
    'connect-github-app',
  ])
  expect(tasksToRecordOf(nothingDone, noRecords, workspacePermissions)).toEqual([])
})
