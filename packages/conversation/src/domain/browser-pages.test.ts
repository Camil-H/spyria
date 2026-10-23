import { expect, test } from 'bun:test'
import { openedPageOf } from './browser-pages.ts'
import { acpUpdate } from './testing.ts'

const openPage = (rawInput: Record<string, unknown>, fields: Record<string, unknown> = {}) =>
  openedPageOf(acpUpdate(1, { sessionUpdate: 'tool_call', title: 'open_page', rawInput, ...fields }, false))

test('an open_page call opens a web address or a workspace file, titled by the agent or by its address', () => {
  expect(openPage({ address: 'https://example.com/docs', title: ' Docs ' })).toEqual({
    url: 'https://example.com/docs',
    title: 'Docs',
  })
  expect(openPage({ address: 'http://example.com' })).toEqual({
    url: 'http://example.com',
    title: 'http://example.com',
  })
  expect(openPage({ address: '/workspace/project/reports/totals.html', title: 'Totals' })).toEqual({
    url: 'reports/totals.html',
    title: 'Totals',
  })
  expect(openPage({ address: './index.html' })).toEqual({ url: 'index.html', title: 'index.html' })
  expect(openPage({ address: 'https://example.com', title: 'x'.repeat(300) })?.title).toHaveLength(200)
})

test('an address with another scheme, outside the workspace, blank or too long opens nothing', () => {
  for (const address of [
    'javascript:alert(1)',
    'data:text/html,<p>',
    'file:///etc/passwd',
    '../secrets.txt',
    'reports/../../x.html',
    '  ',
    'https://',
    `https://example.com/${'a'.repeat(2048)}`,
    42,
  ])
    expect(openPage({ address })).toBeUndefined()
})

test('only the start of an open_page call opens a page, not its update or another tool', () => {
  expect(openPage({ address: 'https://example.com' }, { sessionUpdate: 'tool_call_update' })).toBeUndefined()
  expect(openPage({ address: 'https://example.com' }, { title: 'bash' })).toBeUndefined()
  expect(openedPageOf({ ...acpUpdate(1, {}), kind: 'Other', update: undefined })).toBeUndefined()
})
