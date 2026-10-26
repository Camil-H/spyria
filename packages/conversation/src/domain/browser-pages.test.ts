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

test('an address on the member’s own machine or network opens nothing, in any spelling', () => {
  for (const address of [
    'http://localhost:3000/invoices',
    'http://LOCALHOST./',
    'http://app.localhost',
    'http://printer.local',
    'http://intranet/wiki',
    'http://127.0.0.1:8080',
    'http://127.1',
    'http://2130706433',
    'http://0x7f.1',
    'http://0.0.0.0:3000',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1',
    'https://user:secret@10.0.0.1:8443/x',
    'http://[::1]:3000',
    'http://[::]',
    'http://[0:0:0:0:0:0:0:1]',
    'http://[fe80::1]',
    'http://[fd12:3456::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.0.1]',
  ])
    expect(openPage({ address })).toBeUndefined()
})

test('a public address next to a private range still opens', () => {
  for (const address of [
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://100.128.0.1',
    'http://169.255.0.1',
    'http://11.0.0.1',
    'http://[2606:4700::1111]',
    'http://[::ffff:8.8.8.8]',
    'https://localhost.example.com',
    'https://local.example.com',
  ])
    expect(openPage({ address })?.url).toBe(address)
})

test('only the start of an open_page call opens a page, not its update or another tool', () => {
  expect(openPage({ address: 'https://example.com' }, { sessionUpdate: 'tool_call_update' })).toBeUndefined()
  expect(openPage({ address: 'https://example.com' }, { title: 'bash' })).toBeUndefined()
  expect(openedPageOf({ ...acpUpdate(1, {}), kind: 'Other', update: undefined })).toBeUndefined()
})
