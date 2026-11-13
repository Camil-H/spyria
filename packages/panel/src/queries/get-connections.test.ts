import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getConnections } from './get-connections.ts'

const invoiceBug = chatId('chat-invoice-bug')
const server = (id: string, name: string) => ({
  workspaceId: acme,
  id,
  name,
  gatewayName: `${id}_ab12cd`,
  url: `https://${id}.example.com/mcp`,
  signIn: 'shared' as const,
  setupId: null,
  headerName: null,
  tools: [{ name: 'lookup', readOnly: true, destructive: false }],
  isReviewed: true,
})
const mock = createMockSnapshot()
const snapshot = {
  ...mock,
  chats: mock.chats.map((chat) => (chat.id === invoiceBug ? { ...chat, toolServersOff: ['crm'] } : chat)),
  workspaceConnections: [server('crm', 'CRM'), server('ledger', 'Ledger')],
  connectionAccess: ['crm', 'ledger'].flatMap((connectionId) =>
    ['admin', 'member'].map((roleId) => ({
      workspaceId: acme,
      connectionId,
      roleId,
      level: 'write' as const,
      toolChanges: {},
    })),
  ),
}

test('Connected tools shows which servers are off in the chat, and only a member who manages the chat’s tools switches them', () => {
  const asAlice = getConnections(acme, invoiceBug, alice)(snapshot)
  expect(asAlice?.connections.map(({ name, isOn }) => [name, isOn])).toEqual([
    ['CRM', false],
    ['Ledger', true],
  ])
  expect(asAlice?.canSwitch).toBe(true)
  expect(getConnections(acme, invoiceBug, bob)(snapshot)?.canSwitch).toBe(false)
})
