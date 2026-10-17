import { expect, test } from 'bun:test'
import { toolNamePartsOf } from './tool-names.ts'

test('a gateway tool name splits at its first hyphen into server and tool', () => {
  expect(toolNamePartsOf('Notion-notion-search')).toEqual({ server: 'Notion', tool: 'notion-search' })
  expect(toolNamePartsOf('fake-whoami')).toEqual({ server: 'fake', tool: 'whoami' })
  expect(toolNamePartsOf('terminal')).toEqual({ server: 'terminal', tool: '' })
})
