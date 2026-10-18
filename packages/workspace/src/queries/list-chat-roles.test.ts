import { expect, test } from 'bun:test'
import { acme, createMockSnapshot, globex } from '@hq/db'
import { listChatRoles } from './list-chat-roles.ts'

const snapshot = createMockSnapshot()
const customRole = (id: string, name: string, workspaceId = acme) => ({
  workspaceId,
  id,
  name,
  permissions: ['chat.read' as const, 'session.configure' as const],
  builtIn: false,
})

test('lists the built-in roles from the widest, then the custom roles of the workspace by name', () => {
  const withCustomRoles = {
    ...snapshot,
    chatRoles: [
      customRole('role-reviewer', 'Reviewer'),
      customRole('role-globex', 'Auditor', globex),
      customRole('role-auditor', 'Auditor'),
      ...snapshot.chatRoles,
    ],
  }
  expect(listChatRoles(acme)(withCustomRoles).map((role) => role.name)).toEqual([
    'Owner',
    'Editor',
    'Prompter',
    'Reader',
    'Auditor',
    'Reviewer',
  ])
})
