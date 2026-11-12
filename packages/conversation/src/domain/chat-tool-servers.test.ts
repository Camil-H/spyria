import { expect, test } from 'bun:test'
import { switchedToolServersOf, toolServerOffNoticeOf, toolServersOffAfter } from './chat-tool-servers.ts'
import { TooManyToolServersOff } from './errors.ts'

test('switching a server off adds it once, switching it on removes it, and a chat turns off at most 100', () => {
  expect(toolServersOffAfter([], 'connection-crm', false)).toEqual(['connection-crm'])
  expect(toolServersOffAfter(['connection-crm'], 'connection-crm', false)).toEqual(['connection-crm'])
  expect(toolServersOffAfter(['connection-crm', 'connection-notion'], 'connection-crm', true)).toEqual([
    'connection-notion',
  ])
  expect(toolServersOffAfter([], 'connection-crm', true)).toEqual([])
  const hundred = Array.from({ length: 100 }, (_, index) => `connection-${index}`)
  expect(() => toolServersOffAfter(hundred, 'one-more', false)).toThrow(TooManyToolServersOff)
  expect(toolServersOffAfter(hundred, 'connection-0', false)).toBe(hundred)
})

test('the servers off are named by their gateway name of the moment, so a server whose address changed stays off', () => {
  const catalogue = [
    { id: 'connection-crm', gatewayName: 'crm_99ff00' },
    { id: 'connection-notion', gatewayName: 'notion_ef34ab' },
  ]
  expect(switchedToolServersOf(catalogue, ['connection-crm', 'connection-removed'])).toEqual({
    on: ['notion_ef34ab'],
    off: ['crm_99ff00'],
  })
  expect(switchedToolServersOf(catalogue, ['connection-crm', 'connection-notion'])).toEqual({
    on: [],
    off: ['crm_99ff00', 'notion_ef34ab'],
  })
  expect(toolServerOffNoticeOf('CRM')).toBe('CRM is off for this chat')
})
