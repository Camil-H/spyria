import { expect, test } from 'bun:test'
import { includedToolServersOf, toolServerOffNoticeOf, toolServersOffAfter } from './chat-tool-servers.ts'
import { TooManyToolServersOff } from './errors.ts'

test('switching a server off adds it once, switching it on removes it, and a chat turns off at most 100', () => {
  expect(toolServersOffAfter([], 'crm_ab12cd', false)).toEqual(['crm_ab12cd'])
  expect(toolServersOffAfter(['crm_ab12cd'], 'crm_ab12cd', false)).toEqual(['crm_ab12cd'])
  expect(toolServersOffAfter(['crm_ab12cd', 'notion_ef34ab'], 'crm_ab12cd', true)).toEqual(['notion_ef34ab'])
  expect(toolServersOffAfter([], 'crm_ab12cd', true)).toEqual([])
  const hundred = Array.from({ length: 100 }, (_, index) => `server_${index}`)
  expect(() => toolServersOffAfter(hundred, 'one_more', false)).toThrow(TooManyToolServersOff)
  expect(toolServersOffAfter(hundred, 'server_0', false)).toBe(hundred)
})

test('the gateway includes the catalogue minus the servers off, none when all are off', () => {
  expect(includedToolServersOf(['crm_ab12cd', 'notion_ef34ab'], ['crm_ab12cd'])).toEqual(['notion_ef34ab'])
  expect(includedToolServersOf(['crm_ab12cd'], ['crm_ab12cd'])).toEqual([])
  expect(toolServerOffNoticeOf('CRM')).toBe('CRM is off for this chat')
})
