import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, lee } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getPanelTabs } from './get-panel-tabs.ts'

const snapshot = createMockSnapshot()

test('a runtime chat shows its files and changes, a channel its sources', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), alice)(snapshot)).toEqual([
    'files',
    'changes',
    'commits',
    'browser',
    'usage',
    'connections',
    'members',
  ])
  expect(getPanelTabs(acme, chatId('chat-welcome'), alice)(snapshot)).toEqual([
    'browser',
    'sources',
    'usage',
    'connections',
    'members',
  ])
})

test('the owner’s connections show only to the chat’s participants, not to every reader of a public channel', () => {
  expect(getPanelTabs(acme, chatId('chat-invoice-bug'), lee)(snapshot)).toContain('connections')
  expect(getPanelTabs(acme, chatId('chat-welcome'), lee)(snapshot)).toEqual(['browser', 'sources', 'usage', 'members'])
})
