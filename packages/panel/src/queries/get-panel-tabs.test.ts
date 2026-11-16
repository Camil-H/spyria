import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, lee } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getPanelTabs } from './get-panel-tabs.ts'

const snapshot = createMockSnapshot()

test('a runtime chat shows its changes first, then its files and the member’s own browser; a channel its sources, with no browser since it has no runtime', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), alice)(snapshot)).toEqual([
    'changes',
    'files',
    'browser',
    'usage',
    'connections',
    'members',
  ])
  expect(getPanelTabs(acme, chatId('chat-welcome'), alice)(snapshot)).toEqual([
    'sources',
    'usage',
    'connections',
    'members',
  ])
})

test('the owner’s connections show only to the chat’s participants, not to every reader of a public channel', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), lee)(snapshot)).toContain('connections')
  expect(getPanelTabs(acme, chatId('chat-welcome'), lee)(snapshot)).toEqual(['sources', 'usage', 'members'])
})
