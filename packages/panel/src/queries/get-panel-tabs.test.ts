import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, lee } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getPanelTabs } from './get-panel-tabs.ts'

const snapshot = createMockSnapshot()

test('a runtime chat shows its changes first, then its files, the member’s own browser and the agent’s usage and tools; a channel, which has no agent, only its members', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), alice)(snapshot)).toEqual([
    'changes',
    'files',
    'browser',
    'usage',
    'connections',
    'members',
  ])
  expect(getPanelTabs(acme, chatId('chat-welcome'), alice)(snapshot)).toEqual(['members'])
})

test('the owner’s connections show only to the chat’s participants, not to a member who only reads it', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), lee)(snapshot)).toContain('connections')
  expect(getPanelTabs(acme, chatId('chat-research'), lee)(snapshot)).not.toContain('connections')
})
