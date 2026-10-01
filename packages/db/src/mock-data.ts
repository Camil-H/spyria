import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import type { Snapshot } from './schema.ts'

const acme = workspaceId('workspace-acme')
const globex = workspaceId('workspace-globex')
const alice = memberId('member-alice')
const bob = memberId('member-bob')
const onboarding = projectId('project-onboarding')
const billing = projectId('project-billing')
const launch = projectId('project-launch')

export const currentMemberId = alice
export const defaultWorkspaceId = acme

export const createMockSnapshot = (): Snapshot => ({
  workspaces: [
    { id: acme, name: 'Acme' },
    { id: globex, name: 'Globex' },
  ],
  members: [
    { id: alice, name: 'Alice' },
    { id: bob, name: 'Bob' },
  ],
  memberships: [
    { memberId: alice, workspaceId: acme },
    { memberId: bob, workspaceId: acme },
    { memberId: alice, workspaceId: globex },
  ],
  projects: [
    { id: onboarding, workspaceId: acme, name: 'Onboarding', archived: false },
    { id: billing, workspaceId: acme, name: 'Billing', archived: false },
    { id: launch, workspaceId: globex, name: 'Launch', archived: false },
  ],
  chats: [
    {
      id: chatId('chat-welcome'),
      workspaceId: acme,
      projectId: onboarding,
      type: 'channel',
      name: 'Welcome',
      ownerId: alice,
      archived: false,
    },
    {
      id: chatId('chat-setup-helper'),
      workspaceId: acme,
      projectId: onboarding,
      type: 'runtime',
      name: 'Setup helper',
      ownerId: bob,
      archived: false,
    },
    {
      id: chatId('chat-invoice-bug'),
      workspaceId: acme,
      projectId: billing,
      type: 'runtime',
      name: 'Invoice bug',
      ownerId: alice,
      archived: false,
    },
    {
      id: chatId('chat-standup'),
      workspaceId: acme,
      projectId: null,
      type: 'channel',
      name: 'Standup',
      ownerId: bob,
      archived: false,
    },
    {
      id: chatId('chat-research'),
      workspaceId: acme,
      projectId: null,
      type: 'runtime',
      name: 'Research',
      ownerId: alice,
      archived: false,
    },
    {
      id: chatId('chat-launch-plan'),
      workspaceId: globex,
      projectId: launch,
      type: 'runtime',
      name: 'Launch plan',
      ownerId: alice,
      archived: false,
    },
    {
      id: chatId('chat-general'),
      workspaceId: globex,
      projectId: null,
      type: 'channel',
      name: 'General',
      ownerId: alice,
      archived: false,
    },
  ],
})
